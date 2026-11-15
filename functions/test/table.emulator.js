// The `table` callable end to end, against the emulators:
//   firebase emulators:exec --only functions,firestore "node --test test/table.emulator.js"
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {initializeApp,deleteApp} from 'firebase/app';
import {getFunctions,connectFunctionsEmulator,httpsCallable} from 'firebase/functions';
import {initializeApp as adminApp,deleteApp as deleteAdminApp} from 'firebase-admin/app';
import {getFirestore} from 'firebase-admin/firestore';
import {TILES} from '../src/table.js';
import {inboxOf} from '../src/tableCallable.js';

if(!process.env.FIRESTORE_EMULATOR_HOST)throw Error('Emulator endpoints are required');
const admin=adminApp({projectId:'patzekhna'},'table-integration');
const db=getFirestore(admin);
const app=initializeApp({projectId:'patzekhna',apiKey:'emulator-only',appId:'emulator-only'},'table-integration');
const functions=getFunctions(app,'europe-west1');
connectFunctionsEmulator(functions,'127.0.0.1',Number(process.env.FUNCTIONS_EMULATOR_PORT ?? 5001));
const call=httpsCallable(functions,'table');
after(async()=>{await deleteApp(app);await deleteAdminApp(admin)});

const env='development';
const key=c=>c.repeat(64);
const id=k=>createHash('sha256').update(k).digest('hex');
const player=(k,nickname)=>({playerKey:k,environment:env,nickname,platform:'ios',appVersion:'1.2.5'});
const table=async(who,action,extra={})=>(await call({...who,action,...extra})).data;
const game=async gameId=>(await db.doc(`tables/${env}/games/${gameId}`).get()).data();
const hand=async(gameId,handId)=>(await db.doc(`tables/${env}/games/${gameId}/hands/${handId}`).get()).get('tiles');
const fails=(promise,code,message)=>assert.rejects(promise,e=>e.code===`functions/${code}` && (!message || e.message.includes(message)));
const ready=async(who,gameId,value=true)=>table(who,'ready',{gameId,ready:value});
async function startNow(host,other,gameId) {
  await ready(host,gameId);
  await ready(other,gameId);
  await table(host,'start',{gameId});
  // These tests exercise turns, so advance the emulator's shared start clock past the countdown.
  await db.doc(`tables/${env}/games/${gameId}`).update({'turn.startedMs':Date.now()-1});
}
const spell=(word,used)=>[...word].map(l=>{
  const t=TILES.find(t=>t.letter===l && !used.has(t.id));
  used.add(t.id);
  return t.id;
});

// Puts chosen tiles in a seat's hand, swapping with the pool so the box stays whole.
async function giveHand(gameId,handId,tiles) {
  const g=await game(gameId);
  const secretRef=db.doc(`tables/${env}/games/${gameId}/private/state`);
  const secret=(await secretRef.get()).data();
  const hands=await Promise.all(secret.handIds.map(h=>hand(gameId,h)));
  const mine=secret.handIds.indexOf(handId);
  const wanted=new Set(tiles);
  const freed=hands[mine].filter(t=>!wanted.has(t));
  for(const [i,h] of hands.entries())if(i!==mine)hands[i]=h.map(t=>wanted.has(t) ? freed.pop() : t);
  const pool=secret.pool.map(t=>wanted.has(t) ? freed.pop() : t);
  pool.push(...freed);
  hands[mine]=tiles;
  const onBoard=new Set(g.board.flatMap(w=>w.tiles));
  assert.equal(new Set([...hands.flat(),...pool,...onBoard]).size,106);
  await secretRef.set({...secret,pool});
  await Promise.all(secret.handIds.map((h,i)=>db.doc(`tables/${env}/games/${gameId}/hands/${h}`).set({tiles:hands[i]})));
  await db.doc(`tables/${env}/games/${gameId}`).update({
    seats:g.seats.map((s,i)=>({...s,count:hands[i].length})),pool:pool.length});
}

test('a lobby fills by code, the host starts, and each hand stays private',async()=>{
  const a=player(key('a'),'אריה'), b=player(key('b'),'דוב'), c=player(key('c'),'זאב');
  const made=await table(a,'create',{rackSize:10,turnSeconds:90});
  assert.match(made.code,/^[A-Z2-9]{6}$/);
  const joined=await table(b,'join',{code:made.code});
  assert.equal(joined.gameId,made.gameId);
  assert.notEqual(joined.handId,made.handId);
  assert.deepEqual(await table(b,'join',{code:made.code}).then(r=>r.handId),joined.handId,'joining twice keeps the seat');
  await fails(table(a,'join',{code:'ZZZZZZ'}),'not-found');
  await fails(table(b,'start',{gameId:made.gameId}),'permission-denied');
  await fails(table(a,'start',{gameId:made.gameId}),'failed-precondition','not-ready');
  await ready(a,made.gameId);
  await ready(b,made.gameId);
  await table(a,'settings',{gameId:made.gameId,rackSize:7,colors:3});
  await table(c,'join',{code:made.code});
  await table(c,'leave',{gameId:made.gameId});
  let g=await game(made.gameId);
  assert.equal(g.seats.length,2);
  assert.equal(g.settings.rackSize,7);
  assert.equal(g.settings.turnSeconds,90);
  assert.equal(g.settings.colors,3);
  assert.deepEqual(g.seats.map(s=>s.ready),[false,false],'settings changes clear consent');
  await ready(a,made.gameId);
  await fails(table(a,'start',{gameId:made.gameId}),'failed-precondition','not-ready');
  await ready(b,made.gameId);
  await table(a,'start',{gameId:made.gameId});
  g=await game(made.gameId);
  assert.equal(g.state,'playing');
  assert.equal(g.turn.startedMs-g.startedMs,3_000,'the countdown is three seconds on the server clock');
  assert.ok(g.turn.startedMs>Date.now(),'all phones get a countdown before the first turn');
  assert.equal(g.pool,106-14);
  assert.deepEqual(g.seats.map(s=>s.count),[7,7]);
  assert.ok(Object.keys(g.colors).length>20,'about half the letters painted');
  assert.equal((await hand(made.gameId,made.handId)).length,7);
  assert.equal(JSON.stringify(g).includes(key('a')),false,'the device key itself is never stored');
  assert.equal(JSON.stringify(g).includes(made.handId),false,'no hand id on the public table');
  await fails(table(c,'join',{code:made.code}),'not-found');
});

test('turns: an opening play, a draw, a broken board at timeout, leaving ends the game',async()=>{
  const a=player(key('d'),'נמר'), b=player(key('e'),'צבי');
  const made=await table(a,'create',{});
  const joined=await table(b,'join',{code:made.code});
  await startNow(a,b,made.gameId);
  let g=await game(made.gameId);
  const seats={[g.seats[0].id]:{who:a,handId:made.handId},[g.seats[1].id]:{who:b,handId:joined.handId}};
  const on=()=>seats[g.seats[g.turn.seat].id];
  const off=()=>seats[g.seats[1-g.turn.seat].id];

  // Not your turn, a stale turn, a weak opening: all refused.
  await fails(table(off().who,'draw',{gameId:made.gameId,turn:1}),'failed-precondition','not-your-turn');
  await fails(table(on().who,'draw',{gameId:made.gameId,turn:2}),'failed-precondition','stale');
  const used=new Set();
  const shalom=spell('שלומ',used), sefer=spell('ספר',used);
  const rest=TILES.filter(t=>!used.has(t.id) && !t.joker).slice(0,7).map(t=>t.id);
  await giveHand(made.gameId,on().handId,[...shalom,...sefer,...rest]);
  await fails(table(on().who,'play',{gameId:made.gameId,turn:1,board:[{id:'w1',tiles:shalom}]}),'failed-precondition','opening');

  // A good opening.
  const opener=on();
  await table(opener.who,'play',{gameId:made.gameId,turn:1,board:[{id:'w1',tiles:shalom},{id:'w2',tiles:sefer}]});
  g=await game(made.gameId);
  assert.equal(g.turn.number,2);
  assert.equal(g.board.length,2);
  assert.equal(g.seats.find(s=>s.id===id(opener.who.playerKey)).opened,true);
  assert.deepEqual(g.log.at(-1).words,['שלום','ספר']);
  assert.equal((await hand(made.gameId,opener.handId)).length,7);

  // The other draws one.
  const drawer=on();
  await table(drawer.who,'draw',{gameId:made.gameId,turn:2});
  assert.equal((await hand(made.gameId,drawer.handId)).length,15);

  // Back to the opener: a draft with a short word, then the clock runs out and someone else calls it.
  g=await game(made.gameId);
  const before=(await hand(made.gameId,opener.handId)).length;
  const loose=(await hand(made.gameId,opener.handId)).slice(0,2);
  await table(opener.who,'draft',{gameId:made.gameId,turn:3,board:[...g.board,{id:'w3',tiles:loose}]});
  assert.equal((await game(made.gameId)).draft.board.length,3);
  const early=await table(drawer.who,'timeout',{gameId:made.gameId,turn:3});
  assert.ok(early.retryInMs>0,'too early for the others');
  await db.doc(`tables/${env}/games/${made.gameId}`).update({'turn.endsAt':Date.now()-10_000});
  await table(drawer.who,'timeout',{gameId:made.gameId,turn:3});
  g=await game(made.gameId);
  assert.equal(g.log.at(-1).type,'penalty');
  assert.equal(g.board.length,2,'the broken board went back');
  assert.equal((await hand(made.gameId,opener.handId)).length,before+3);
  assert.equal(g.seats.find(s=>s.id===id(opener.who.playerKey)).missed,1);

  // Leaving with two at the table ends it, and the other wins.
  await table(drawer.who,'leave',{gameId:made.gameId});
  g=await game(made.gameId);
  assert.equal(g.state,'finished');
  assert.equal(g.result.reason,'left');
  assert.equal(g.seats[g.result.winner].id,id(opener.who.playerKey));

  // "עוד משחק": the first opens a lobby, the next joins it.
  const again=await table(opener.who,'again',{gameId:made.gameId});
  assert.equal((await game(made.gameId)).next,again.gameId);
  const second=await table(drawer.who,'again',{gameId:made.gameId});
  assert.equal(second.gameId,again.gameId);
  assert.equal((await game(again.gameId)).seats.length,2);
});

test('the player out of tiles wins and the others pay their hands',async()=>{
  const a=player(key('f'),'ארנב'), b=player(key('9'),'חתול');
  const made=await table(a,'create',{rackSize:7});
  const joined=await table(b,'join',{code:made.code});
  await startNow(a,b,made.gameId);
  let g=await game(made.gameId);
  const on=g.seats[g.turn.seat].id===id(a.playerKey) ? {who:a,handId:made.handId} : {who:b,handId:joined.handId};
  const used=new Set();
  const shalom=spell('שלומ',used), sefer=spell('ספר',used);
  await giveHand(made.gameId,on.handId,[...shalom,...sefer]);
  await table(on.who,'play',{gameId:made.gameId,turn:1,board:[{id:'w1',tiles:shalom},{id:'w2',tiles:sefer}]});
  g=await game(made.gameId);
  assert.equal(g.state,'finished');
  assert.equal(g.result.reason,'empty');
  assert.equal(g.seats[g.result.winner].id,id(on.who.playerKey));
  assert.ok(g.seats[g.result.winner].score>0);
  assert.ok(g.seats[1-g.result.winner].score<0);
});

test('asking the table: the clock stops, a majority accepts, and the word then plays',async()=>{
  const a=player(key('7'),'ינשוף'), b=player(key('8'),'עורב');
  const made=await table(a,'create',{});
  const joined=await table(b,'join',{code:made.code});
  await startNow(a,b,made.gameId);
  let g=await game(made.gameId);
  const on=g.seats[g.turn.seat].id===id(a.playerKey) ? {who:a,handId:made.handId} : {who:b,handId:joined.handId};
  const off=on.who===a ? b : a;
  const used=new Set();
  const word=spell('בבבבב',used), shalom=spell('שלומ',used), sefer=spell('ספר',used);
  await giveHand(made.gameId,on.handId,[...word,...shalom,...sefer]);
  const board=[{id:'w1',tiles:word},{id:'w2',tiles:shalom},{id:'w3',tiles:sefer}];
  await fails(table(on.who,'play',{gameId:made.gameId,turn:1,board}),'failed-precondition','unknown');
  await fails(table(on.who,'ask',{gameId:made.gameId,turn:1,words:[{key:'שלומ',text:'שלום'}]}),'invalid-argument');
  const asked=await table(on.who,'ask',{gameId:made.gameId,turn:1,words:[{key:'בבבבב',text:'בבבבב'}]});
  g=await game(made.gameId);
  assert.equal(g.vote.words[0].key,'בבבבב');
  assert.ok(g.turn.endsAt>=asked.endsAt,'the clock stands still for the vote');
  await fails(table(on.who,'ask',{gameId:made.gameId,turn:1,words:[{key:'גגגגג',text:'גגגגג'}]}),'failed-precondition');
  await fails(table(on.who,'play',{gameId:made.gameId,turn:1,board}),'failed-precondition','voting');
  await fails(table(on.who,'vote',{gameId:made.gameId,turn:1,accept:['בבבבב']}),'permission-denied');
  const voted=await table(off,'vote',{gameId:made.gameId,turn:1,accept:['בבבבב']});
  assert.equal(voted.settled,true,'the only voter voted: settled at once');
  g=await game(made.gameId);
  assert.equal(g.vote,null);
  assert.deepEqual(g.accepted,['בבבבב']);
  assert.equal(g.log.at(-1).type,'vote');
  assert.deepEqual(g.log.at(-1).accepted,['בבבבב']);
  const review=(await db.doc(`wordReviews/${env}/words/בבבבב`).get()).data();
  assert.equal(review.asks,1);
  assert.equal(review.accepted,1);
  await table(on.who,'play',{gameId:made.gameId,turn:1,board});
  g=await game(made.gameId);
  // Those were all of the player's letters: the voted word played, and the player went out.
  assert.equal(g.state,'finished');
  assert.equal(g.result.reason,'empty');
  assert.equal(g.board.length,3);
});

test("StageAdmin's lists: a denied word is refused, an allowed one plays",async()=>{
  await db.doc(`dictionaryLists/${env}`).set({allow:['דדדד'],deny:['שלומ']});
  const a=player(key('5'),'צבי'), b=player(key('6'),'איל');
  const made=await table(a,'create',{});
  const joined=await table(b,'join',{code:made.code});
  await startNow(a,b,made.gameId);
  const g=await game(made.gameId);
  const on=g.seats[g.turn.seat].id===id(a.playerKey) ? {who:a,handId:made.handId} : {who:b,handId:joined.handId};
  const used=new Set();
  const allowed=spell('דדדד',used), shalom=spell('שלומ',used), sefer=spell('ספר',used);
  await giveHand(made.gameId,on.handId,[...allowed,...shalom,...sefer]);
  await fails(table(on.who,'play',{gameId:made.gameId,turn:1,
    board:[{id:'w1',tiles:allowed},{id:'w2',tiles:shalom},{id:'w3',tiles:sefer}]}),'failed-precondition','unknown');
  await table(on.who,'play',{gameId:made.gameId,turn:1,board:[{id:'w1',tiles:allowed},{id:'w3',tiles:sefer}]});
  assert.equal((await game(made.gameId)).turn.number,2);
  await db.doc(`dictionaryLists/${env}`).delete();
});

test('friends: an invitation lands in the friend\'s own inbox with the code',async()=>{
  const a=player(key('3'),'דבורה'), b=player(key('4'),'נחליאלי'), c=player(key('2'),'זר');
  // b has been at a table before, so the server knows b's inbox.
  const earlier=await table(b,'create',{});
  await table(b,'leave',{gameId:earlier.gameId});
  const made=await table(a,'create',{});
  await fails(table(a,'inviteFriend',{gameId:made.gameId,friend:id(key('9').replace(/9/g,'1'))}),'not-found','unknown-friend');
  await fails(table(a,'inviteFriend',{gameId:made.gameId,friend:id(a.playerKey)}),'invalid-argument');
  await table(a,'inviteFriend',{gameId:made.gameId,friend:id(b.playerKey)});
  const inbox=(await db.doc(`tables/${env}/inboxes/${inboxOf(b.playerKey)}`).get()).data();
  assert.equal(inbox.invites.length,1);
  assert.equal(inbox.invites[0].code,made.code);
  assert.equal(inbox.invites[0].from,'דבורה');
  assert.equal(inbox.invites[0].fromId,id(a.playerKey));
  assert.equal(JSON.stringify(inbox).includes(b.playerKey),false,'the key itself is never stored');
  // Someone not at the table cannot invite from it.
  await fails(table(c,'inviteFriend',{gameId:made.gameId,friend:id(b.playerKey)}),'permission-denied');
  await table(b,'join',{code:made.code});
  await fails(table(a,'inviteFriend',{gameId:made.gameId,friend:id(b.playerKey)}),'failed-precondition','seated');
  const g=await game(made.gameId);
  assert.ok(g.expireAt,'a table carries its expiry');
});

test('friends: presence follows the foreground session and expires without a close',async()=>{
  const a=player(key('5'),'צופה'), b=player(key('6'),'חבר');
  const aId=id(a.playerKey), bId=id(b.playerKey);
  const first='1'.repeat(32), second='2'.repeat(32), late='3'.repeat(32);
  const online=async()=> (await table(a,'friendPresence',{friends:[bId,aId]})).online;
  assert.deepEqual(await online(),[]);
  await table(b,'presence',{mode:'open',session:first});
  assert.deepEqual(await online(),[bId]);
  await table(b,'presence',{mode:'pulse',session:first});
  await table(b,'presence',{mode:'close',session:first});
  assert.deepEqual(await online(),[]);
  await table(b,'presence',{mode:'pulse',session:first});
  await table(b,'presence',{mode:'open',session:first});
  assert.deepEqual(await online(),[],'a closed session cannot come back from an in-flight call');
  await table(b,'presence',{mode:'open',session:second});
  await table(b,'presence',{mode:'close',session:late});
  await table(b,'presence',{mode:'open',session:late});
  assert.deepEqual(await online(),[bId],'a delayed open after its close cannot replace the current session');
  await table(b,'presence',{mode:'close',session:first});
  assert.deepEqual(await online(),[bId],'an old close cannot hide a newer session');
  await db.doc(`tables/${env}/players/${bId}`).update({onlineUntilMs:Date.now()-1});
  assert.deepEqual(await online(),[],'a crashed phone goes offline when its lease ends');
  await fails(table(a,'friendPresence',{friends:['bad']}),'invalid-argument');
});

test('statistics: one document a day, aggregated, with no player in it',async()=>{
  const {statsDay}=await import('../src/stats.js');
  const day=db.doc(`tableStats/${env}/days/${statsDay()}`);
  const before=(await day.get()).data() ?? {};
  const a=player(key('c'),'שחף'), b=player(key('d'),'עגור');
  const made=await table(a,'create',{rackSize:7,colors:2});
  const joined=await table(b,'join',{code:made.code});
  await table(a,'ready',{gameId:made.gameId,ready:true}).catch(()=>{});
  await table(b,'ready',{gameId:made.gameId,ready:true}).catch(()=>{});
  await table(a,'start',{gameId:made.gameId});
  let g=await game(made.gameId);
  await db.doc(`tables/${env}/games/${made.gameId}`).update({'turn.startedMs':0,colors:{}});
  const on=g.seats[g.turn.seat].id===id(a.playerKey) ? {who:a,handId:made.handId} : {who:b,handId:joined.handId};
  // A refused turn is counted by its reason.
  await fails(table(on.who,'play',{gameId:made.gameId,turn:1,board:[]}),'failed-precondition','nothing');
  const used=new Set();
  const shalom=spell('שלומ',used), sefer=spell('ספר',used);
  await giveHand(made.gameId,on.handId,[...shalom,...sefer]);
  await table(on.who,'play',{gameId:made.gameId,turn:1,board:[{id:'w1',tiles:shalom},{id:'w2',tiles:sefer}]});
  const after=(await day.get()).data();
  const grew=k=>(after[k] ?? 0)-(before[k] ?? 0);
  const grewIn=(m,k)=>(after[m]?.[k] ?? 0)-(before[m]?.[k] ?? 0);
  assert.equal(grew('tablesCreated'),1);
  assert.equal(grew('joins'),1);
  assert.equal(grew('gamesStarted'),1);
  assert.equal(grew('plays'),1);
  assert.equal(grew('tilesPlayed'),7);
  assert.equal(grew('wordsMade'),2);
  assert.equal(grew('openings'),1);
  assert.equal(grew('gamesFinished'),1);
  assert.equal(grewIn('ends','empty'),1);
  assert.equal(grewIn('players','2'),1);
  assert.equal(grewIn('rackSize','7'),1);
  assert.equal(grewIn('colors','2'),1);
  assert.equal(grewIn('platforms','ios'),2);
  assert.equal(grewIn('refusals','nothing'),1);
  assert.equal(after.day,statsDay());
  const text=JSON.stringify(after);
  assert.equal(text.includes(id(a.playerKey)) || text.includes('שחף'),false,'no player in the statistics');
});

test('prices: only players who can pay sit down, and the winner takes the pot less the cut',async()=>{
  const a={...player(key('e'),'נשר'),balance:60}, b=player(key('f'),'ינשוף');
  const made=await table(a,'create',{stake:100});
  let g=await game(made.gameId);
  assert.equal(g.settings.stake,50,'the dearest price the host can pay');
  await fails(table(b,'join',{code:made.code}),'failed-precondition','update');
  await fails(table({...b,balance:10},'join',{code:made.code}),'failed-precondition','diamonds');
  await table({...b,balance:500},'join',{code:made.code});
  await fails(table({...b,balance:30},'ready',{gameId:made.gameId,ready:true}),'failed-precondition','diamonds');
  await table({...b,balance:500},'ready',{gameId:made.gameId,ready:true});
  // A price the host cannot pay is refused; a cheaper one clears everyone's readiness.
  await fails(table(a,'settings',{gameId:made.gameId,stake:100}),'failed-precondition','diamonds');
  await table(a,'settings',{gameId:made.gameId,stake:20});
  g=await game(made.gameId);
  assert.equal(g.settings.stake,20);
  assert.equal(g.seats[1].ready,false);
  await table({...b,balance:500},'ready',{gameId:made.gameId,ready:true});
  await table(a,'ready',{gameId:made.gameId,ready:true});
  await table(a,'start',{gameId:made.gameId});
  g=await game(made.gameId);
  assert.equal(g.houseCut,10);
  await table(b,'leave',{gameId:made.gameId});
  g=await game(made.gameId);
  assert.equal(g.state,'finished');
  assert.equal(g.result.pot,40);
  assert.deepEqual(g.result.payouts,[36,0],'40 less 10%');
});

// The word table's one callable (README.md, "Backend"), on the duel's pattern: every write goes through
// here, keyed by the device's player key; the phones read their table and their own hand by id, with live listeners.
//
// Paths, under `tables/{env}`:
//   games/{id}                 the table: seats, settings, the board, whose turn and until when, the log, the result.
//                              Anyone with the id reads it; it never holds a hand.
//   games/{id}/hands/{handId}  one seat's tiles. Only that phone knows the random hand id, so only it reads them.
//   games/{id}/private/state   the pool and which hand id belongs to which seat. No client reads it.
//   invites/{code}             a lobby's code → its table, while the lobby is open.
import {createHash,randomBytes} from 'node:crypto';
import {getFirestore,FieldValue} from 'firebase-admin/firestore';
import {onCall,HttpsError} from 'firebase-functions/v2/https';
import {validatePlayerDetails,validCode,validMatchID,makeCode} from './players.js';
import {boardNickname} from './nicknames.js';
import {tableRules,tableSettings,deal,paint,checkPlay,handValue,nextSeat,finalScores,readAsked,tally} from './table.js';
import {isWord,dictionaryVersion} from './dictionary.js';

const actions=['create','join','settings','start','draft','play','draw','timeout','leave','away','back','again',
  'ask','vote','settle'];
// "The table has moved on", not a bad request: the app drops the move and follows the table.
const stale=['stale','not-your-turn','not-playing','voting'];

const newHandId=()=>randomBytes(15).toString('base64url');

function seat(id,details,now) {
  return {id,nickname:details.nickname,platform:details.platform,appVersion:details.appVersion,joinedMs:now,
    count:0,opened:false,left:false,away:false,missed:0,score:null,value:null};
}

export const table=onCall({region:'europe-west1',maxInstances:10},async request=>{
  const data=request.data;
  if(typeof data?.playerKey!=='string' || !/^[0-9a-f]{64}$/.test(data.playerKey))
    throw new HttpsError('invalid-argument','Invalid player');
  if(!['development','production'].includes(data?.environment))throw new HttpsError('invalid-argument','Invalid environment');
  if(!actions.includes(data.action))throw new HttpsError('invalid-argument','Invalid action');
  const env=data.environment;
  const player=createHash('sha256').update(data.playerKey).digest('hex');
  const db=getFirestore();
  const root=db.collection('tables').doc(env);
  const games=root.collection('games');
  const details=async()=>{
    let me;
    try { me=validatePlayerDetails(data); } catch(e) { throw new HttpsError('invalid-argument',e.message); }
    return {...me,nickname:await boardNickname(env,player,me.nickname)};
  };
  const gameRef=()=>{
    if(!validMatchID(data.gameId))throw new HttpsError('invalid-argument','Invalid table');
    return games.doc(data.gameId);
  };
  const reply=result=>({ok:true,serverNow:Date.now(),...result});
  const refuse=(code,message=code)=>{ throw new HttpsError(stale.includes(code) ? 'failed-precondition' : 'invalid-argument',message); };

  // Reads a table with its private state and every hand, all before any write (Firestore transactions read first).
  async function load(tx,ref,{hands=false}={}) {
    const doc=await tx.get(ref);
    if(!doc.exists)throw new HttpsError('not-found','No such table');
    const game=doc.data();
    const privateRef=ref.collection('private').doc('state');
    const secret=(await tx.get(privateRef)).data() ?? {pool:[],handIds:[]};
    let handDocs=[];
    if(hands && game.state==='playing') {
      const refs=secret.handIds.map(h=>ref.collection('hands').doc(h));
      handDocs=refs.length ? await tx.getAll(...refs) : [];
    }
    const me=game.seats.findIndex(s=>s.id===player);
    return {game,secret,privateRef,me,hands:handDocs.map(d=>d.get('tiles') ?? []),
      handRef:i=>ref.collection('hands').doc(secret.handIds[i])};
  }
  const mine=t=>{ if(t.me<0)throw new HttpsError('permission-denied','Not your table'); return t.me; };

  // A new lobby with the caller as host, and a free code for it.
  async function openLobby(tx,me,settings,now,previous=null,round=1) {
    let code, invite;
    for(let attempt=0;attempt<6 && !invite;attempt++) {
      code=makeCode();
      const ref=root.collection('invites').doc(code);
      const old=await tx.get(ref);
      if(!old.exists || old.get('expiresMs')<=now)invite=ref;
    }
    if(!invite)throw new HttpsError('unavailable','No free code; try again');
    const ref=games.doc();
    const handId=newHandId();
    const expiresMs=now+tableRules.lobbyMs;
    tx.set(ref,{state:'lobby',code,createdMs:now,expiresMs,host:player,settings,seats:[seat(player,me,now)],board:[],
      jokers:{},colors:{},accepted:[],vote:null,dictionary:dictionaryVersion,pool:0,turn:null,draft:null,log:[],passStreak:0,result:null,next:null,previous,round,startedMs:null,
      finishedMs:null,updatedAt:FieldValue.serverTimestamp()});
    tx.set(ref.collection('private').doc('state'),{pool:[],handIds:[handId]});
    tx.set(invite,{gameId:ref.id,expiresMs});
    return {gameId:ref.id,code,handId,expiresMs};
  }

  // The turn is over: the next seat that is still in plays, with a fresh clock.
  function advance(game,now) {
    const seat=nextSeat(game.seats,game.turn.seat);
    game.turn={number:game.turn.number+1,seat,startedMs:now,endsAt:now+game.settings.turnSeconds*1000};
    game.draft=null;
    game.vote=null;
  }
  function log(game,entry,now) {
    game.log=[...game.log,{...entry,turn:game.turn?.number ?? 0,at:now}].slice(-tableRules.logSize);
  }
  function finish(game,hands,winner,reason,now) {
    const values=game.seats.map((s,i)=>handValue(hands[i] ?? []));
    const result=finalScores(game.seats,values,winner);
    game.seats=game.seats.map((s,i)=>({...s,score:result.scores[i],value:values[i]}));
    game.state='finished';
    game.result={winner:result.winner,reason,values};
    game.finishedMs=now;
    game.draft=null;
    log(game,{type:'end',seat:result.winner,reason},now);
  }
  // Ends the table if fewer than two are still in; true if it did.
  function lastOneStanding(game,hands,now) {
    const inGame=game.seats.map((s,i)=>i).filter(i=>!game.seats[i].left);
    if(inGame.length>=2)return false;
    finish(game,hands,inGame[0] ?? null,'left',now);
    return true;
  }
  // Takes up to `count` from the pool into a hand.
  function draw(secret,hand,count) {
    const taken=secret.pool.splice(Math.max(0,secret.pool.length-count),count);
    hand.push(...taken);
    return taken.length;
  }
  // The table document's writable part, as it is saved after a change.
  const saved=game=>({...game,updatedAt:FieldValue.serverTimestamp()});

  // A proposed turn (a play, or the board standing when the clock ran out) against the table's rules.
  function judge(game,hand,seatIndex,proposal) {
    try {
      return checkPlay({board:game.board,jokers:game.jokers,colors:game.colors ?? {},hand,
        opened:game.seats[seatIndex].opened,settings:game.settings,isWord,accepted:game.accepted ?? []},proposal);
    } catch(e) { throw new HttpsError('invalid-argument',e.message); }
  }
  // Puts a good turn on the table; true if the player went out and won.
  function commitPlay(game,hands,secret,seatIndex,result,now,type='play') {
    const jokers={...game.jokers};
    for(const id of Object.keys(jokers))if(!result.board.some(w=>w.tiles.includes(id)))delete jokers[id];
    Object.assign(jokers,result.jokers);
    game.board=result.board;
    game.jokers=jokers;
    hands[seatIndex]=result.hand;
    const opening=!game.seats[seatIndex].opened;
    game.seats[seatIndex]={...game.seats[seatIndex],opened:true,count:result.hand.length,missed:0};
    game.passStreak=0;
    log(game,{type,seat:seatIndex,tiles:result.played.length,words:result.words.slice(0,8),opening},now);
    if(result.hand.length===0) { finish(game,hands,seatIndex,'empty',now); return true; }
    return false;
  }
  // No play: one letter from the pool, or a pass when it is empty. A full round of passes ends the game.
  function drawOrPass(game,hands,secret,seatIndex,now,type='draw') {
    const hand=[...hands[seatIndex]];
    const got=draw(secret,hand,1);
    hands[seatIndex]=hand;
    game.seats[seatIndex]={...game.seats[seatIndex],count:hand.length};
    game.pool=secret.pool.length;
    if(got) { game.passStreak=0; log(game,{type,seat:seatIndex,count:1},now); return false; }
    game.passStreak=(game.passStreak ?? 0)+1;
    log(game,{type:'pass',seat:seatIndex},now);
    if(game.passStreak>=game.seats.filter(s=>!s.left).length) { finish(game,hands,null,'blocked',now); return true; }
    return false;
  }
  function writeHands(tx,t,hands,before) {
    hands.forEach((tiles,i)=>{
      if(before && before[i]===tiles)return;
      tx.set(t.handRef(i),{tiles,updatedMs:Date.now()});
    });
  }
  // The current turn as the caller sees it: theirs, this number, the table running.
  function onTurn(game,seatIndex) {
    if(game.state!=='playing')refuse('not-playing');
    if(Number(data.turn)!==game.turn.number)refuse('stale');
    if(game.turn.seat!==seatIndex)refuse('not-your-turn');
  }
  // Who may vote on a word the player on turn asked about: everyone else still at the table.
  const voters=game=>game.seats.map((s,i)=>i).filter(i=>!game.seats[i].left && i!==game.vote?.by);
  // Counts a vote, adds what passed to the table's own words, logs it, gives the turn back its clock, and keeps every
  // asked word for StageAdmin's review. Called by `settle` once the time is up, or by `vote` once all have voted.
  function settleVote(tx,game,now) {
    const vote=game.vote;
    const eligible=voters(game);
    const {accepted,rejected}=tally(vote,eligible);
    game.accepted=[...new Set([...(game.accepted ?? []),...accepted.map(w=>w.key)])];
    game.turn={...game.turn,endsAt:now+vote.left};
    game.vote=null;
    log(game,{type:'vote',seat:vote.by,accepted:accepted.map(w=>w.text),rejected:rejected.map(w=>w.text)},now);
    for(const word of vote.words) {
      tx.set(db.collection('wordReviews').doc(env).collection('words').doc(word.key),{
        text:word.text,asks:FieldValue.increment(1),accepted:FieldValue.increment(accepted.includes(word) ? 1 : 0),
        lastMs:now,lastVotes:Object.keys(vote.votes ?? {}).length,lastVoters:eligible.length
      },{merge:true});
    }
  }

  switch(data.action) {
  case 'create': {
    const me=await details();
    const settings=tableSettings(data);
    return reply(await db.runTransaction(tx=>openLobby(tx,me,settings,Date.now())));
  }

  case 'join': {
    const me=await details();
    if(!validCode(data.code))throw new HttpsError('invalid-argument','Invalid code');
    const invite=root.collection('invites').doc(data.code);
    return reply(await db.runTransaction(async tx=>{
      const now=Date.now();
      const doc=await tx.get(invite);
      if(!doc.exists || doc.get('expiresMs')<=now)throw new HttpsError('not-found','expired');
      const ref=games.doc(doc.get('gameId'));
      const t=await load(tx,ref);
      if(t.me>=0)return {gameId:ref.id,handId:t.secret.handIds[t.me],code:t.game.code};
      if(t.game.state!=='lobby')throw new HttpsError(t.game.state==='cancelled' ? 'not-found' : 'failed-precondition',
        t.game.state==='cancelled' ? 'expired' : 'started');
      if(t.game.seats.length>=tableRules.maxPlayers)throw new HttpsError('failed-precondition','full');
      const handId=newHandId();
      tx.update(ref,{seats:[...t.game.seats,seat(player,me,now)],updatedAt:FieldValue.serverTimestamp()});
      tx.set(t.privateRef,{...t.secret,handIds:[...t.secret.handIds,handId]});
      return {gameId:ref.id,handId,code:t.game.code};
    }));
  }

  case 'settings': {
    const ref=gameRef();
    return reply(await db.runTransaction(async tx=>{
      const t=await load(tx,ref);
      if(t.game.host!==player)throw new HttpsError('permission-denied','Only the host');
      if(t.game.state!=='lobby')refuse('not-playing');
      const settings=tableSettings({...t.game.settings,...data});
      tx.update(ref,{settings,updatedAt:FieldValue.serverTimestamp()});
      return {settings};
    }));
  }

  case 'start': {
    const ref=gameRef();
    return reply(await db.runTransaction(async tx=>{
      const now=Date.now();
      const t=await load(tx,ref);
      const game=t.game;
      if(game.host!==player)throw new HttpsError('permission-denied','Only the host');
      if(game.state!=='lobby')return {state:game.state};
      if(game.seats.length<tableRules.minPlayers)throw new HttpsError('failed-precondition','alone');
      const {hands,pool}=deal(game.seats.length,game.settings.rackSize);
      const first=Math.floor(Math.random()*game.seats.length);
      game.state='playing';
      game.startedMs=now;
      game.colors=paint(game.settings.colors ?? 1);
      game.seats=game.seats.map((s,i)=>({...s,count:hands[i].length}));
      game.pool=pool.length;
      game.turn={number:1,seat:first,startedMs:now,
        endsAt:now+tableRules.startDelayMs+game.settings.turnSeconds*1000};
      tx.set(ref,saved(game));
      tx.set(t.privateRef,{...t.secret,pool});
      writeHands(tx,t,hands);
      tx.delete(root.collection('invites').doc(game.code));
      return {state:'playing'};
    }));
  }

  // The player on turn shows the others what they are building. Only the shape is checked; the rules wait for the play.
  case 'draft': {
    const ref=gameRef();
    return reply(await db.runTransaction(async tx=>{
      const now=Date.now();
      const t=await load(tx,ref,{hands:true});
      onTurn(t.game,mine(t));
      const shape=judge(t.game,t.hands[t.me],t.me,data);
      tx.update(ref,{draft:{turn:t.game.turn.number,board:shape.board,jokers:shape.jokers,at:now},
        updatedAt:FieldValue.serverTimestamp()});
      return {};
    }));
  }

  case 'play': {
    const ref=gameRef();
    return reply(await db.runTransaction(async tx=>{
      const now=Date.now();
      const t=await load(tx,ref,{hands:true});
      const game=t.game, me=mine(t);
      onTurn(game,me);
      if(game.vote)refuse('voting');
      if(now>game.turn.endsAt+tableRules.graceMs)refuse('stale','Time is up');
      const result=judge(game,t.hands[me],me,data);
      // The first problem, with its details (the unknown words, the short word…), for the phone to show.
      if(result.errors.length)throw new HttpsError('failed-precondition',result.errors[0].code,result.errors[0]);
      const hands=[...t.hands];
      const won=commitPlay(game,hands,t.secret,me,result,now);
      if(!won)advance(game,now);
      tx.set(ref,saved(game));
      writeHands(tx,t,hands,t.hands);
      return {state:game.state};
    }));
  }

  case 'draw': {
    const ref=gameRef();
    return reply(await db.runTransaction(async tx=>{
      const now=Date.now();
      const t=await load(tx,ref,{hands:true});
      const game=t.game, me=mine(t);
      onTurn(game,me);
      if(game.vote)refuse('voting');
      const hands=[...t.hands];
      game.seats[me]={...game.seats[me],missed:0};
      if(!drawOrPass(game,hands,t.secret,me,now))advance(game,now);
      tx.set(ref,saved(game));
      tx.set(t.privateRef,t.secret);
      writeHands(tx,t,hands,t.hands);
      return {state:game.state};
    }));
  }

  // The clock ran out. The player's own phone sends its board as the clock hits zero; any other phone may call once
  // the grace has passed too, and then the last draft stands for the board. A good board is played; tiles placed on a
  // broken one go back and the penalty is drawn; nothing placed draws one. A seat that misses three turns in a row with
  // its app gone is out.
  case 'timeout': {
    const ref=gameRef();
    return reply(await db.runTransaction(async tx=>{
      const now=Date.now();
      const t=await load(tx,ref,{hands:true});
      const game=t.game, caller=mine(t);
      if(game.state!=='playing')return {state:game.state};
      if(Number(data.turn)!==game.turn.number)return {state:game.state,turn:game.turn.number};
      // The clock stands still while the table votes; `settle` gives it back.
      if(game.vote)return {state:game.state,voting:true,retryInMs:Math.max(1_000,game.vote.endsAt+tableRules.graceMs-now)};
      const seatIndex=game.turn.seat;
      const own=caller===seatIndex;
      const due=own ? game.turn.endsAt-1_000 : game.turn.endsAt+tableRules.graceMs;
      if(now<due)return {state:game.state,retryInMs:due-now};
      const proposal=own && Array.isArray(data.board) ? data
        : game.draft?.turn===game.turn.number ? game.draft : null;
      const hands=[...t.hands];
      let over=false;
      const result=proposal ? (()=>{ try { return judge(game,hands[seatIndex],seatIndex,proposal); } catch { return null; } })() : null;
      if(result && !result.errors.length) {
        over=commitPlay(game,hands,t.secret,seatIndex,result,now,'timeout-play');
      } else if(result && result.played.length) {
        const hand=[...hands[seatIndex]];
        const count=draw(t.secret,hand,game.settings.timeoutPenalty);
        hands[seatIndex]=hand;
        game.seats[seatIndex]={...game.seats[seatIndex],count:hand.length};
        game.pool=t.secret.pool.length;
        game.passStreak=0;
        log(game,{type:'penalty',seat:seatIndex,count},now);
      } else {
        over=drawOrPass(game,hands,t.secret,seatIndex,now,'timeout-draw');
      }
      if(!over) {
        const missed=own ? 0 : (game.seats[seatIndex].missed ?? 0)+1;
        game.seats[seatIndex]={...game.seats[seatIndex],missed};
        if(missed>=tableRules.maxMissed) {
          game.seats[seatIndex]={...game.seats[seatIndex],left:true,dropped:true};
          log(game,{type:'dropped',seat:seatIndex},now);
          over=lastOneStanding(game,hands,now);
        }
      }
      if(!over)advance(game,now);
      tx.set(ref,saved(game));
      tx.set(t.privateRef,t.secret);
      writeHands(tx,t,hands,t.hands);
      return {state:game.state};
    }));
  }

  // In the lobby: out of the seat (the next player hosts; the last one out closes it). In a game: out for good, and
  // the turn moves on if it was theirs. After the end: only marks them gone, for "עוד משחק".
  case 'leave': {
    const ref=gameRef();
    return reply(await db.runTransaction(async tx=>{
      const now=Date.now();
      const t=await load(tx,ref,{hands:true});
      const game=t.game;
      if(t.me<0)return {state:game.state};
      const me=t.me;
      const invite=root.collection('invites').doc(game.code);
      if(game.state==='lobby') {
        const seats=game.seats.filter((s,i)=>i!==me);
        const handIds=t.secret.handIds.filter((h,i)=>i!==me);
        if(!seats.length) {
          tx.update(ref,{seats,state:'cancelled',finishedMs:now,updatedAt:FieldValue.serverTimestamp()});
          tx.delete(invite);
        } else {
          tx.update(ref,{seats,host:game.host===player ? seats[0].id : game.host,updatedAt:FieldValue.serverTimestamp()});
        }
        tx.set(t.privateRef,{...t.secret,handIds});
        return {state:seats.length ? 'lobby' : 'cancelled'};
      }
      if(game.state==='playing') {
        if(game.seats[me].left)return {state:game.state};
        game.seats[me]={...game.seats[me],left:true};
        log(game,{type:'left',seat:me},now);
        const hands=[...t.hands];
        if(!lastOneStanding(game,hands,now) && game.turn.seat===me)advance(game,now);
        tx.set(ref,saved(game));
        return {state:game.state};
      }
      if(game.state==='finished' && !game.seats[me].left) {
        game.seats[me]={...game.seats[me],left:true};
        tx.update(ref,{seats:game.seats,updatedAt:FieldValue.serverTimestamp()});
      }
      return {state:game.state};
    }));
  }

  // The app went to the background, or came back: the others see "לא באפליקציה". The clock does not stop.
  case 'away': case 'back': {
    const ref=gameRef();
    return reply(await db.runTransaction(async tx=>{
      const t=await load(tx,ref);
      const me=mine(t);
      const away=data.action==='away';
      if(t.game.seats[me].away===away || !['lobby','playing'].includes(t.game.state))return {state:t.game.state};
      const seats=t.game.seats.map((s,i)=>i===me ? {...s,away} : s);
      tx.update(ref,{seats,updatedAt:FieldValue.serverTimestamp()});
      return {state:t.game.state};
    }));
  }

  // "בקשו מהשולחן לאשר": the player on turn, once a turn, asks the others to accept words the dictionary lacks. The
  // turn's clock stops for the vote and takes up where it left off when the vote is settled.
  case 'ask': {
    const ref=gameRef();
    return reply(await db.runTransaction(async tx=>{
      const now=Date.now();
      const t=await load(tx,ref);
      const game=t.game, me=mine(t);
      onTurn(game,me);
      if(game.vote)refuse('voting');
      if(game.turn.asked)throw new HttpsError('failed-precondition','asked');
      if(now>game.turn.endsAt)refuse('stale','Time is up');
      let words;
      try { words=readAsked(data.words,isWord,game.accepted ?? []); }
      catch(e) { throw new HttpsError('invalid-argument',e.message); }
      const left=Math.max(5_000,game.turn.endsAt-now);
      const endsAt=now+tableRules.voteMs;
      game.vote={by:me,words,votes:{},endsAt,left,turn:game.turn.number};
      // The clock cannot run out while the table votes: it is set to the vote's end plus what was left.
      game.turn={...game.turn,asked:true,endsAt:endsAt+left};
      log(game,{type:'ask',seat:me,words:words.map(w=>w.text)},now);
      tx.set(ref,saved(game));
      return {endsAt};
    }));
  }

  // A vote on every asked word at once: `accept` lists the keys this player accepts; the rest are "no". A vote can
  // be changed until the time is up. When everyone has voted, the vote is settled at once.
  case 'vote': {
    const ref=gameRef();
    return reply(await db.runTransaction(async tx=>{
      const now=Date.now();
      const t=await load(tx,ref);
      const game=t.game, me=mine(t);
      if(!game.vote || Number(data.turn)!==game.vote.turn)refuse('stale');
      if(!voters(game).includes(me))throw new HttpsError('permission-denied','Not a voter');
      if(now>game.vote.endsAt+tableRules.graceMs)refuse('stale','Time is up');
      const keys=new Set(game.vote.words.map(w=>w.key));
      const accept=Array.isArray(data.accept) ? [...new Set(data.accept.filter(k=>keys.has(k)))] : [];
      game.vote={...game.vote,votes:{...game.vote.votes,[String(me)]:accept}};
      const done=voters(game).every(seat=>game.vote.votes[String(seat)]);
      if(done)settleVote(tx,game,now);
      tx.set(ref,saved(game));
      return {settled:done};
    }));
  }

  // Any phone, once the vote's time is up: counts it and gives the turn its clock back. Twice changes nothing.
  case 'settle': {
    const ref=gameRef();
    return reply(await db.runTransaction(async tx=>{
      const now=Date.now();
      const t=await load(tx,ref);
      const game=t.game;
      mine(t);
      if(!game.vote)return {settled:true};
      if(now<game.vote.endsAt)return {retryInMs:game.vote.endsAt-now};
      settleVote(tx,game,now);
      tx.set(ref,saved(game));
      return {settled:true};
    }));
  }

  // "עוד משחק" after the end: the first to ask opens a new lobby with the same settings and points the old table to
  // it; everyone after joins that lobby.
  case 'again': {
    const me=await details();
    const ref=gameRef();
    return reply(await db.runTransaction(async tx=>{
      const now=Date.now();
      const t=await load(tx,ref);
      mine(t);
      if(t.game.state!=='finished')throw new HttpsError('failed-precondition','not-finished');
      if(t.game.next) {
        const nextRef=games.doc(t.game.next);
        const n=await load(tx,nextRef);
        if(n.me>=0)return {gameId:nextRef.id,handId:n.secret.handIds[n.me],code:n.game.code};
        if(n.game.state!=='lobby')throw new HttpsError('failed-precondition','started');
        if(n.game.seats.length>=tableRules.maxPlayers)throw new HttpsError('failed-precondition','full');
        const handId=newHandId();
        tx.update(nextRef,{seats:[...n.game.seats,seat(player,me,now)],updatedAt:FieldValue.serverTimestamp()});
        tx.set(n.privateRef,{...n.secret,handIds:[...n.secret.handIds,handId]});
        return {gameId:nextRef.id,handId,code:n.game.code};
      }
      const lobby=await openLobby(tx,me,t.game.settings,now,ref.id,(t.game.round ?? 1)+1);
      tx.update(ref,{next:lobby.gameId,updatedAt:FieldValue.serverTimestamp()});
      return lobby;
    }));
  }
  }
});

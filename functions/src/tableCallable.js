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
import {getFirestore,FieldValue,Timestamp} from 'firebase-admin/firestore';
import {onCall,HttpsError} from 'firebase-functions/v2/https';
import {validatePlayerDetails,validCode,validMatchID,makeCode} from './players.js';
import {boardNickname} from './nicknames.js';
import {tableRules,tableSettings,tableTuning,chooseStake,deal,paint,checkPlay,nextSeat,readAsked,tally,kickSeat,maxSeats,discoverable,joinable}
  from './table.js';
import {dictionaryVersion,withLists,listsFor} from './dictionary.js';
import {statsDay,newTally,statsKey} from './stats.js';
import {botRules,validLevel,thinkMs,findMove,isBotTable,botSeat,botReveal} from './bots.js';
import {tableLeaseMs,visibleRoom,expiredSeat,finishTable} from './tableLifecycle.js';

const actions=['create','join','settings','ready','start','draft','play','draw','timeout','leave','away','back','again',
  'presence','friendPresence',
  'ask','vote','settle','inviteFriend','addBot','removeBot','botLevel','kick',
  'browseLobby','lobbyPresence','joinPublic','tablePulse'];
// "The table has moved on", not a bad request: the app drops the move and follows the table.
const stale=['stale','not-your-turn','not-playing','voting','starting'];

const newHandId=()=>randomBytes(15).toString('base64url');
const newBotId=()=>`bot-${randomBytes(6).toString('hex')}`;
// Changing who sits at a lobby clears the players' readiness, as changing the settings does; bots stay ready.
const unready=s=>s.bot ? s : {...s,ready:false};
// A bot's turn begins with two moments: `botAt`, when it finds its move, and `botThink`, when the move is played (its
// level's share of the clock).
const botClock=(game,seat,startedMs)=>({botAt:startedMs+botRules.lookMs,
  botThink:startedMs+Math.max(botRules.lookMs+1_000,thinkMs(game.seats[seat].level,game.settings.turnSeconds))});

// How long a table stays after its last change: every write moves `expireAt` this far ahead, on the table, its hands,
// its private state and its code, and Firestore's TTL policy on `expireAt` deletes what nobody touched since. A
// finished, cancelled or abandoned table is gone a month later.
const keepMs=30*24*60*60_000;
const expireAt=()=>Timestamp.fromMillis(Date.now()+keepMs);
const stamp=()=>({updatedAt:FieldValue.serverTimestamp(),expireAt:expireAt()});
const kept=data=>({...data,expireAt:expireAt()});

// Friends (README.md, "Friends"). A player's inbox is addressed by a hash of their device key, which only their own
// phone can work out; it listens there for invitations. The server keeps which inbox belongs to which player id in
// tablePlayers/{env}/players/{id} (no client reads it), written whenever the player opens or joins a table, so a
// friend can be invited by the id every table already shows.
export const inboxOf=playerKey=>createHash('sha256').update(`table-inbox:${playerKey}`).digest('hex');
const playerKeepMs=365*24*60*60_000;
const inviteRules={perMinute:10,kept:10};
const presenceLeaseMs=45_000;
const lobbyRoomsLimit=40;
const lobbyVisitorsLimit=40;

// The game's settings for prices (table.js, `tableTuning`): read once a minute per instance, every time in the emulator.
const tuningCache=new Map();
async function tuningFor(db,env) {
  const hit=tuningCache.get(env);
  if(hit && Date.now()-hit.at<60_000 && process.env.FUNCTIONS_EMULATOR!=='true')return hit.tuning;
  let payload=null;
  try {
    const doc=await db.collection('gameTuning').doc(env).get();
    payload=doc.exists ? JSON.parse(doc.get('payload')) : null;
  } catch { payload=null; }
  const tuning=tableTuning(payload);
  tuningCache.set(env,{at:Date.now(),tuning});
  return tuning;
}

function seat(id,details,now,managed=false) {
  return {id,nickname:details.nickname,platform:details.platform,appVersion:details.appVersion,joinedMs:now,
    count:0,opened:false,ready:false,left:false,away:false,missed:0,score:null,value:null,
    ...(managed ? {leaseManaged:true,tableUntilMs:now+tableLeaseMs} : {})};
}

// 512 MiB: the bots' move finder indexes the dictionary by its letters once per instance (about 40 MB more).
export const table=onCall({region:'europe-west1',maxInstances:10,memory:'512MiB'},async request=>{
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
  const playerRef=id=>root.collection('players').doc(id);
  // Only clients that understand the table lease opt into the single-active-table contract. Older releases keep
  // their existing create/join behavior until the new apps ship.
  const managed=data.managed===true;
  async function reserveActive(tx,targetId,now) {
    if(!managed)return;
    const ref=playerRef(player);
    const current=await tx.get(ref);
    const oldId=current.get('activeGameId');
    if(oldId && oldId!==targetId && (current.get('activeGameUntilMs') ?? 0)>now) {
      const old=await tx.get(games.doc(oldId));
      const game=old.data();
      const seat=game?.seats.findIndex(seat=>seat.id===player && !seat.left) ?? -1;
      if(game && ['lobby','playing'].includes(game.state) && seat>=0) {
        const secret=await tx.get(games.doc(oldId).collection('private').doc('state'));
        throw new HttpsError('failed-precondition','active-room',
          {gameId:oldId,handId:secret.get('handIds')?.[seat] ?? null});
      }
    }
    tx.set(ref,{activeGameId:targetId,activeGameUntilMs:now+tableLeaseMs},{merge:true});
  }
  // This phone's inbox address, kept for its friends' invitations.
  const register=async me=>{
    await playerRef(player).set({inbox:inboxOf(data.playerKey),nickname:me.nickname,platform:me.platform,seenMs:Date.now(),
      expireAt:Timestamp.fromMillis(Date.now()+playerKeepMs)},{merge:true});
  };
  // The dictionary for this request: the built list with StageAdmin's allow and deny lists on top.
  let wordCheck=null;
  const isWord=async()=>wordCheck ??= withLists(await listsFor(db,env));
  // Daily aggregated statistics (stats.js): each transaction attempt gathers its counts and writes them once.
  let tallied=newTally();
  const count=(path,n=1)=>tallied.add(path,n);
  const statsRef=()=>db.collection('tableStats').doc(env).collection('days').doc(statsDay());
  const runTx=fn=>db.runTransaction(async tx=>{
    tallied=newTally();
    const result=await fn(tx);
    if(tallied.size)tx.set(statsRef(),{day:statsDay(),updatedMs:Date.now(),...tallied.update(n=>FieldValue.increment(n))},{merge:true});
    return result;
  });
  const refuse=(code,message=code)=>{ throw new HttpsError(stale.includes(code) ? 'failed-precondition' : 'invalid-argument',message); };
  // Diamonds live on the phones (the game's DIAMONDS.md), so each call says what its player has. A table with a price
  // takes only players whose balance covers it; an app from before prices sends none and is told to update.
  const balance=Number.isInteger(data.balance) && data.balance>=0 ? data.balance : undefined;
  const covers=stake=>{
    if(!stake)return;
    if(balance===undefined)throw new HttpsError('failed-precondition','update');
    if(balance<stake)throw new HttpsError('failed-precondition','diamonds',{stake,balance});
  };

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
  // What each human pays when the game starts: against bots only, StageAdmin's flat price; otherwise the seat's price.
  const priceOf=(game,tuning)=>isBotTable(game.seats) ? tuning.botPrice : (game.settings.stake ?? 0);

  // A new lobby with the caller as host, and a free code for it.
  async function openLobby(tx,me,settings,now,previous=null,round=1,bots=[],visibility='private') {
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
    await reserveActive(tx,ref.id,now);
    // "עוד משחק" brings the bots along, at their levels.
    const seats=[seat(player,me,now,managed)];
    for(const b of bots)seats.push(botSeat(seats,b.level,now,newBotId()));
    const room={state:'lobby',visibility,code,createdMs:now,expiresMs,host:player,settings,seats};
    tx.set(ref,{...room,discoverable:discoverable(room),board:[],
      jokers:{},colors:{},accepted:[],vote:null,dictionary:dictionaryVersion,pool:0,turn:null,draft:null,log:[],passStreak:0,result:null,next:null,previous,round,startedMs:null,
      finishedMs:null,...stamp()});
    tx.set(ref.collection('private').doc('state'),kept({pool:[],handIds:[handId,...bots.map(()=>newHandId())]}));
    tx.set(invite,{gameId:ref.id,expiresMs,expireAt:Timestamp.fromMillis(expiresMs+24*60*60_000)});
    count('tablesCreated');
    if(previous)count('againTables');
    return {gameId:ref.id,code,handId,expiresMs};
  }

  // The turn is over: the next seat that is still in plays, with a fresh clock.
  function advance(game,now) {
    const seat=nextSeat(game.seats,game.turn.seat);
    game.turn={number:game.turn.number+1,seat,startedMs:now,endsAt:now+game.settings.turnSeconds*1000};
    if(game.seats[seat]?.bot)Object.assign(game.turn,botClock(game,seat,now));
    game.draft=null;
    game.vote=null;
  }
  function log(game,entry,now) {
    game.log=[...game.log,{...entry,turn:game.turn?.number ?? 0,at:now}].slice(-tableRules.logSize);
  }
  function finish(game,hands,winner,reason,now) {
    finishTable(game,hands,winner,reason,now,count);
  }
  // Ends the table if fewer than two are still in, or no human is; true if it did. With only bots left, the
  // lowest hand among them is the winner, and the humans (all gone) forfeit.
  function lastOneStanding(game,hands,now) {
    const inGame=game.seats.map((s,i)=>i).filter(i=>!game.seats[i].left);
    if(inGame.length>=2 && inGame.some(i=>!game.seats[i].bot))return false;
    finish(game,hands,inGame.length===1 ? inGame[0] : null,'left',now);
    return true;
  }
  // Takes up to `count` from the pool into a hand.
  function draw(secret,hand,count) {
    const taken=secret.pool.splice(Math.max(0,secret.pool.length-count),count);
    hand.push(...taken);
    return taken.length;
  }
  // The table document's writable part, as it is saved after a change.
  const saved=game=>({...game,...stamp()});

  // A proposed turn (a play, or the board standing when the clock ran out) against the table's rules.
  function judge(game,hand,seatIndex,proposal) {
    try {
      return checkPlay({board:game.board,jokers:game.jokers,colors:game.colors ?? {},hand,
        opened:game.seats[seatIndex].opened,settings:game.settings,isWord:wordCheck,accepted:game.accepted ?? []},proposal);
    } catch(e) { throw new HttpsError('invalid-argument',e.message); }
  }
  // Puts a good turn on the table; true if the player went out and won.
  function commitPlay(game,hands,secret,seatIndex,result,now,type='play',bot=false) {
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
    if(bot) {
      count('botPlays');
      count('botTiles',result.played.length);
    } else {
      count(type==='play' ? 'plays' : 'timeoutPlays');
      count('tilesPlayed',result.played.length);
      count('wordsMade',result.words.length);
      if(opening)count('openings');
    }
    if(result.hand.length===0) { finish(game,hands,seatIndex,'empty',now); return true; }
    return false;
  }
  // No play: one letter from the pool, or a pass when it is empty. A full round of passes ends the game.
  function drawOrPass(game,hands,secret,seatIndex,now,type='draw',bot=false) {
    const hand=[...hands[seatIndex]];
    const got=draw(secret,hand,1);
    hands[seatIndex]=hand;
    game.seats[seatIndex]={...game.seats[seatIndex],count:hand.length};
    game.pool=secret.pool.length;
    if(got) {
      game.passStreak=0;
      log(game,{type,seat:seatIndex,count:1},now);
      count(bot ? 'botDraws' : type==='draw' ? 'draws' : 'timeoutDraws');
      return false;
    }
    count('passes');
    game.passStreak=(game.passStreak ?? 0)+1;
    log(game,{type:'pass',seat:seatIndex},now);
    if(game.passStreak>=game.seats.filter(s=>!s.left).length) { finish(game,hands,null,'blocked',now); return true; }
    return false;
  }
  function writeHands(tx,t,hands,before) {
    hands.forEach((tiles,i)=>{
      if(before && before[i]===tiles)return;
      tx.set(t.handRef(i),kept({tiles,updatedMs:Date.now()}));
    });
  }
  // The current turn as the caller sees it: theirs, this number, the table running.
  function onTurn(game,seatIndex) {
    if(game.state!=='playing')refuse('not-playing');
    if(Number(data.turn)!==game.turn.number)refuse('stale');
    if(game.turn.seat!==seatIndex)refuse('not-your-turn');
    if(Date.now()<game.turn.startedMs)refuse('starting');
  }
  // Who may vote on a word the player on turn asked about: every other human still at the table (bots don't vote).
  const voters=game=>game.seats.map((s,i)=>i).filter(i=>!game.seats[i].left && !game.seats[i].bot && i!==game.vote?.by);
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
    count('wordsAccepted',accepted.length);
    count('wordsRejected',rejected.length);
    for(const word of vote.words) {
      tx.set(db.collection('wordReviews').doc(env).collection('words').doc(word.key),{
        text:word.text,asks:FieldValue.increment(1),accepted:FieldValue.increment(accepted.includes(word) ? 1 : 0),
        lastMs:now,lastVotes:Object.keys(vote.votes ?? {}).length,lastVoters:eligible.length
      },{merge:true});
    }
  }

  // A bot's turn (bots.js), in two steps, each when a phone at the table calls `timeout` at `turn.botAt`. First the
  // bot finds its move and saves it as its draft with the window its letters arrive in (`from`–`until`), and `botAt`
  // moves to when it is played; then the draft is played. A bot with no move waits for its time, then draws. The
  // rules check the move like any other; one they refuse (a word denied since) becomes a draw.
  function botTurn(tx,ref,t,now) {
    const game=t.game, seatIndex=game.turn.seat, bot=game.seats[seatIndex];
    const hands=[...t.hands];
    const safely=fn=>{ try { return fn(); } catch { return null; } };
    const good=proposal=>{ const r=proposal && safely(()=>judge(game,hands[seatIndex],seatIndex,proposal)); return r && !r.errors.length ? r : null; };
    let over;
    if(game.draft?.turn===game.turn.number && game.draft.bot) {
      const result=good(game.draft);
      over=result ? commitPlay(game,hands,t.secret,seatIndex,result,now,'play',true)
        : drawOrPass(game,hands,t.secret,seatIndex,now,'draw',true);
    } else if(game.turn.botPlan==='draw') {
      over=drawOrPass(game,hands,t.secret,seatIndex,now,'draw',true);
    } else {
      const result=good(safely(()=>findMove({board:game.board,jokers:game.jokers,colors:game.colors ?? {},
        hand:hands[seatIndex],opened:bot.opened,settings:game.settings,isWord:wordCheck,accepted:game.accepted ?? [],
        turn:game.turn.number},bot.level)));
      const think=game.turn.botThink ?? now;
      if(result) {
        const {from,until,commitAt}=botReveal(bot.level,result.played.length,now,think,game.turn.endsAt);
        game.draft={turn:game.turn.number,board:result.board,jokers:result.jokers,at:now,bot:true,from,until};
        game.turn={...game.turn,botAt:commitAt};
        tx.set(ref,saved(game));
        return {state:game.state,retryInMs:commitAt-now};
      }
      if(now<think) {
        game.turn={...game.turn,botAt:think,botPlan:'draw'};
        tx.set(ref,saved(game));
        return {state:game.state,retryInMs:think-now};
      }
      over=drawOrPass(game,hands,t.secret,seatIndex,now,'draw',true);
    }
    if(!over)advance(game,now);
    tx.set(ref,saved(game));
    tx.set(t.privateRef,kept(t.secret));
    writeHands(tx,t,hands,t.hands);
    return {state:game.state};
  }

  async function joinSeat(tx,ref,me,now,publicOnly=false) {
    const t=await load(tx,ref);
    const game=t.game;
    if(t.me>=0) {
      await reserveActive(tx,ref.id,now);
      return {gameId:ref.id,handId:t.secret.handIds[t.me],code:game.code};
    }
    if((game.kicked ?? []).includes(player))throw new HttpsError('permission-denied','removed');
    if(game.state!=='lobby' || (game.expiresMs ?? 0)<=now)
      throw new HttpsError('failed-precondition','started');
    if(publicOnly) {
      if(game.visibility!=='public')throw new HttpsError('failed-precondition','private');
      const host=await tx.get(playerRef(game.host));
      const hostSeat=game.seats.find(s=>s.id===game.host);
      if((host.get('onlineUntilMs') ?? 0)<=now || hostSeat?.away || !hostSeat || expiredSeat(hostSeat,now))
        throw new HttpsError('failed-precondition','unavailable');
    }
    if(game.seats.length>=maxSeats(game))throw new HttpsError('failed-precondition','full');
    covers(game.settings.stake);
    const handId=newHandId();
    const seats=[...game.seats.map(unready),seat(player,me,now,managed)];
    await reserveActive(tx,ref.id,now);
    tx.update(ref,{seats,discoverable:discoverable({...game,seats}),...stamp()});
    tx.set(t.privateRef,kept({...t.secret,handIds:[...t.secret.handIds,handId]}));
    count('joins');
    if(publicOnly)count('publicJoins');
    return {gameId:ref.id,handId,code:game.code};
  }

  switch(data.action) {
  case 'browseLobby': {
    const now=Date.now();
    const [gamesPage,visitorsPage]=await Promise.all([
      games.where('discoverable','==',true).orderBy('createdMs','desc').limit(lobbyRoomsLimit*2).get(),
      root.collection('players').where('lobbyUntilMs','>',now).orderBy('lobbyUntilMs','desc')
        .limit(lobbyVisitorsLimit+1).get(),
    ]);
    const candidates=gamesPage.docs.map(doc=>({id:doc.id,...doc.data()})).filter(game=>
      discoverable(game) && visibleRoom(game,now) &&
      !game.seats.some(seat=>!seat.bot && !seat.left && seat.id===player) &&
      !(game.kicked ?? []).includes(player));
    const hosts=[...new Set(candidates.filter(game=>game.state==='lobby').map(game=>game.host))];
    const hostDocs=hosts.length ? await db.getAll(...hosts.map(playerRef)) : [];
    const online=new Set(hostDocs.filter(doc=>(doc.get('onlineUntilMs') ?? 0)>now).map(doc=>doc.id));
    const listed=candidates.filter(game=>visibleRoom(game,now,online.has(game.host)));
    const status=game=>game.state==='playing' ? 'playing' : joinable(game) ? 'available' : 'full';
    const priority={available:0,full:1,playing:2};
    listed.sort((a,b)=>priority[status(a)]-priority[status(b)] || b.createdMs-a.createdMs);
    const visible=listed.slice(0,lobbyRoomsLimit);
    const allRooms=visible.map(game=>({
      gameId:game.id,host:game.seats.find(s=>s.id===game.host)?.nickname ?? 'שחקן',
      seats:game.seats.filter(s=>!s.left).length,maxPlayers:maxSeats(game),
      bots:game.seats.filter(s=>s.bot && !s.left).length,
      stake:game.settings.stake ?? 0,rackSize:game.settings.rackSize,
      turnSeconds:game.settings.turnSeconds,colors:game.settings.colors ?? 1,
      status:status(game),
    }));
    const activeVisitors=visitorsPage.docs.filter(doc=>doc.id!==player).slice(0,lobbyVisitorsLimit);
    const people=new Map(activeVisitors.map(doc=>[doc.id,{nickname:doc.get('lobbyNickname') ?? 'שחקן',busy:false}]));
    // A seat in a public room is busy even before the game starts: its host is no longer browsing.
    for(const game of visible) {
      for(const seat of game.seats.filter(seat=>!seat.bot && !seat.left && seat.id!==player))
        people.set(seat.id,{nickname:seat.nickname,busy:true,roomId:game.id});
    }
    const players=[...people.values()].sort((a,b)=>Number(a.busy)-Number(b.busy) ||
      a.nickname.localeCompare(b.nickname,'he'));
    // Older app builds still read these keys and never offer a full or started room as joinable.
    const rooms=allRooms.filter(room=>room.status==='available');
    const visitors=activeVisitors.map(doc=>doc.get('lobbyNickname') ?? 'שחקן');
    return reply({rooms,visitors,allRooms,players});
  }

  case 'lobbyPresence': {
    if(!['open','pulse','close'].includes(data.mode) ||
       typeof data.session!=='string' || !/^[0-9a-f]{32}$/.test(data.session))
      throw new HttpsError('invalid-argument','Invalid lobby presence');
    const me=data.mode==='open' ? await details() : null;
    return reply(await runTx(async tx=>{
      const ref=playerRef(player);
      const old=await tx.get(ref);
      const now=Date.now();
      const closed=old.get('lobbyClosedSessions') ?? [];
      if(data.mode==='open') {
        if(closed.includes(data.session))return {online:false};
        tx.set(ref,{lobbySession:data.session,lobbyUntilMs:now+presenceLeaseMs,
          lobbyNickname:me.nickname,expireAt:Timestamp.fromMillis(now+playerKeepMs)},{merge:true});
        return {online:true};
      }
      if(data.mode==='close') {
        const lobbyClosedSessions=[...new Set([...closed,data.session])].slice(-8);
        if(!old.exists || old.get('lobbySession')===data.session)
          tx.set(ref,{lobbySession:data.session,lobbyClosedSessions,lobbyUntilMs:0,
            expireAt:Timestamp.fromMillis(now+playerKeepMs)},{merge:true});
        else tx.update(ref,{lobbyClosedSessions});
        return {online:false};
      }
      if(old.get('lobbySession')!==data.session || closed.includes(data.session))return {online:false};
      tx.update(ref,{lobbyUntilMs:now+presenceLeaseMs});
      return {online:true};
    }));
  }

  // A short lease says that the whole app is in front, including outside the word table.
  // Recent close tombstones prevent in-flight opens and pulses from restoring a closed session.
  case 'presence': {
    if(!['open','pulse','close'].includes(data.mode) ||
       typeof data.session!=='string' || !/^[0-9a-f]{32}$/.test(data.session))
      throw new HttpsError('invalid-argument','Invalid presence');
    const ref=playerRef(player);
    let me=null;
    if(data.mode==='open') {
      try { me=validatePlayerDetails(data); }
      catch(e) { throw new HttpsError('invalid-argument',e.message); }
    }
    return reply(await runTx(async tx=>{
      const old=await tx.get(ref);
      const now=Date.now();
      const closed=old.get('closedSessions') ?? [];
      if(data.mode==='open') {
        if(closed.includes(data.session))return {online:false};
        tx.set(ref,{inbox:inboxOf(data.playerKey),nickname:me.nickname,platform:me.platform,
          seenMs:now,expireAt:Timestamp.fromMillis(now+playerKeepMs),
          presenceSession:data.session,onlineUntilMs:now+presenceLeaseMs},{merge:true});
        return {online:true};
      }
      if(data.mode==='close') {
        const closedSessions=[...new Set([...closed,data.session])].slice(-8);
        if(!old.exists || old.get('presenceSession')===data.session)
          tx.set(ref,{presenceSession:data.session,closedSessions,onlineUntilMs:0,
            expireAt:Timestamp.fromMillis(now+playerKeepMs)},{merge:true});
        else tx.update(ref,{closedSessions});
        return {online:false};
      }
      if(old.get('presenceSession')!==data.session || closed.includes(data.session))
        return {online:false};
      tx.update(ref,{onlineUntilMs:now+presenceLeaseMs});
      return {online:true};
    }));
  }

  case 'friendPresence': {
    const ids=data.friends;
    if(!Array.isArray(ids) || ids.length>200 || ids.some(id=>typeof id!=='string' || !/^[0-9a-f]{64}$/.test(id)))
      throw new HttpsError('invalid-argument','Invalid friends');
    const unique=[...new Set(ids)].filter(id=>id!==player);
    const docs=unique.length ? await db.getAll(...unique.map(playerRef)) : [];
    const now=Date.now();
    return reply({online:docs.filter(doc=>(doc.get('onlineUntilMs') ?? 0)>now).map(doc=>doc.id)});
  }

  // New clients renew only the table they actually have on screen. An old client has no leaseManaged seat;
  // the scheduled stale-turn fallback handles it without disconnecting it at rollout.
  case 'tablePulse': {
    const ref=gameRef();
    return reply(await runTx(async tx=>{
      const t=await load(tx,ref);
      const me=mine(t);
      if(!['lobby','playing'].includes(t.game.state) || t.game.seats[me].left)
        return {active:false,state:t.game.state};
      const now=Date.now();
      const seats=t.game.seats.map((seat,i)=>i===me ? {...seat,leaseManaged:true,tableUntilMs:now+tableLeaseMs} : seat);
      await reserveActive(tx,ref.id,now);
      tx.update(ref,{seats,...stamp()});
      return {active:true,untilMs:now+tableLeaseMs};
    }));
  }

  case 'create': {
    if(data.visibility!==undefined && !['private','public'].includes(data.visibility))
      throw new HttpsError('invalid-argument','Invalid visibility');
    if(data.maxPlayers!==undefined && !tableRules.maxPlayersOptions.includes(data.maxPlayers))
      throw new HttpsError('invalid-argument','Invalid capacity');
    const me=await details();
    await register(me);
    const tuning=await tuningFor(db,env);
    const stake=chooseStake(tuning,data.stake,balance);
    if(stake==null)throw new HttpsError('failed-precondition',balance===undefined ? 'update' : 'diamonds',{stake:tuning.options[0],balance});
    const settings=tableSettings({...data,stake},tuning);
    return reply(await runTx(tx=>openLobby(tx,me,settings,Date.now(),null,1,[],data.visibility ?? 'private')));
  }

  case 'join': {
    const me=await details();
    await register(me);
    if(!validCode(data.code))throw new HttpsError('invalid-argument','Invalid code');
    const invite=root.collection('invites').doc(data.code);
    return reply(await runTx(async tx=>{
      const now=Date.now();
      const doc=await tx.get(invite);
      if(!doc.exists || doc.get('expiresMs')<=now)throw new HttpsError('not-found','expired');
      return joinSeat(tx,games.doc(doc.get('gameId')),me,now);
    }));
  }

  case 'joinPublic': {
    const me=await details();
    await register(me);
    const ref=gameRef();
    return reply(await runTx(tx=>joinSeat(tx,ref,me,Date.now(),true)));
  }

  case 'settings': {
    const ref=gameRef();
    if(data.visibility!==undefined && !['private','public'].includes(data.visibility))
      throw new HttpsError('invalid-argument','Invalid visibility');
    if(data.maxPlayers!==undefined && !tableRules.maxPlayersOptions.includes(data.maxPlayers))
      throw new HttpsError('invalid-argument','Invalid capacity');
    const tuning=await tuningFor(db,env);
    return reply(await runTx(async tx=>{
      const t=await load(tx,ref);
      if(t.game.host!==player)throw new HttpsError('permission-denied','Only the host');
      if(t.game.state!=='lobby')refuse('not-playing');
      // A price the settings no longer offer stays until the host picks another.
      const offered=tuning.options.includes(t.game.settings.stake) ? tuning
        : {...tuning,options:[...tuning.options,t.game.settings.stake ?? 0]};
      const settings=tableSettings({...t.game.settings,...data},offered);
      if(settings.maxPlayers<t.game.seats.length)throw new HttpsError('failed-precondition','occupied');
      if(settings.stake!==(t.game.settings.stake ?? 0))covers(settings.stake);
      const changed=['rackSize','turnSeconds','colors','stake'].some(key=>settings[key]!==t.game.settings[key]);
      const visibility=data.visibility ?? t.game.visibility ?? 'private';
      const game={...t.game,settings,visibility};
      tx.update(ref,{settings,visibility,discoverable:discoverable(game),
        seats:changed ? t.game.seats.map(unready) : t.game.seats,...stamp()});
      return {settings,visibility};
    }));
  }

  case 'ready': {
    const ref=gameRef();
    if(typeof data.ready!=='boolean')throw new HttpsError('invalid-argument','Invalid readiness');
    const tuning=await tuningFor(db,env);
    return reply(await runTx(async tx=>{
      const t=await load(tx,ref);
      const me=mine(t);
      if(t.game.state!=='lobby')refuse('not-playing');
      if(data.ready)covers(priceOf(t.game,tuning));
      const seats=t.game.seats.map((s,i)=>i===me ? {...s,ready:data.ready} : s);
      tx.update(ref,{seats,...stamp()});
      return {ready:data.ready};
    }));
  }

  case 'start': {
    const ref=gameRef();
    const tuning=await tuningFor(db,env);
    return reply(await runTx(async tx=>{
      const now=Date.now();
      const t=await load(tx,ref);
      const game=t.game;
      if(game.host!==player)throw new HttpsError('permission-denied','Only the host');
      if(game.state!=='lobby')return {state:game.state};
      if(game.seats.length<tableRules.minPlayers)throw new HttpsError('failed-precondition','alone');
      if(game.seats.some(s=>!s.ready))throw new HttpsError('failed-precondition','not-ready');
      // Bots never pay; a table of the host and bots only costs the host StageAdmin's flat price, with no pot.
      const botTable=isBotTable(game.seats);
      const price=priceOf(game,tuning);
      covers(price);
      const {hands,pool}=deal(game.seats.length,game.settings.rackSize);
      const first=Math.floor(Math.random()*game.seats.length);
      game.state='playing';
      game.discoverable=discoverable(game);
      game.startedMs=now;
      // The cut is fixed when the game starts, so a change in StageAdmin never touches a game being played.
      game.houseCut=tuning.houseCut;
      game.botTable=botTable;
      game.price=price;
      game.colors=paint(game.settings.colors ?? 1);
      game.seats=game.seats.map((s,i)=>({...s,count:hands[i].length}));
      game.pool=pool.length;
      game.turn={number:1,seat:first,startedMs:now+tableRules.startDelayMs,
        endsAt:now+tableRules.startDelayMs+game.settings.turnSeconds*1000};
      if(game.seats[first].bot)Object.assign(game.turn,botClock(game,first,game.turn.startedMs));
      tx.set(ref,saved(game));
      tx.set(t.privateRef,kept({...t.secret,pool}));
      writeHands(tx,t,hands);
      tx.delete(root.collection('invites').doc(game.code));
      count('gamesStarted');
      count(`players.${game.seats.length}`);
      count(`rackSize.${statsKey(game.settings.rackSize)}`);
      count(`turnSeconds.${statsKey(game.settings.turnSeconds)}`);
      count(`colors.${statsKey(game.settings.colors ?? 1)}`);
      const bots=game.seats.filter(s=>s.bot);
      for(const s of game.seats)if(!s.bot)count(`platforms.${statsKey(s.platform)}`);
      if(bots.length) {
        count('botGames');
        if(botTable)count('botOnlyGames');
        for(const b of bots)count(`botLevels.${statsKey(b.level)}`);
      }
      if(botTable) {
        if(price)count('botTableDiamonds',price);
      } else {
        count(`stakes.${statsKey(game.settings.stake ?? 0)}`);
        if(game.settings.stake)count('diamondsStaked',game.settings.stake*(game.seats.length-bots.length));
      }
      return {state:'playing'};
    }));
  }

  // The player on turn shows the others what they are building. Only the shape is checked; the rules wait for the play.
  case 'draft': {
    const ref=gameRef();
    return reply(await runTx(async tx=>{
      const now=Date.now();
      const t=await load(tx,ref,{hands:true});
      onTurn(t.game,mine(t));
      const shape=judge(t.game,t.hands[t.me],t.me,data);
      tx.update(ref,{draft:{turn:t.game.turn.number,board:shape.board,jokers:shape.jokers,at:now},
        ...stamp()});
      return {};
    }));
  }

  case 'play': {
    const ref=gameRef();
    await isWord();
    // A turn the rules refused is counted on its own, since its transaction writes nothing.
    let refused=null;
    try { return reply(await runPlay()); }
    catch(e) {
      if(refused)await statsRef().set({day:statsDay(),updatedMs:Date.now(),
        refusals:{[statsKey(refused)]:FieldValue.increment(1)}},{merge:true}).catch(()=>{});
      throw e;
    }
    async function runPlay() { return runTx(async tx=>{
      const now=Date.now();
      const t=await load(tx,ref,{hands:true});
      const game=t.game, me=mine(t);
      onTurn(game,me);
      if(game.vote)refuse('voting');
      if(now>game.turn.endsAt+tableRules.graceMs)refuse('stale','Time is up');
      const result=judge(game,t.hands[me],me,data);
      // The first problem, with its details (the unknown words, the short word…), for the phone to show.
      if(result.errors.length) {
        refused=result.errors[0].code;
        throw new HttpsError('failed-precondition',result.errors[0].code,result.errors[0]);
      }
      const hands=[...t.hands];
      const won=commitPlay(game,hands,t.secret,me,result,now);
      if(!won)advance(game,now);
      tx.set(ref,saved(game));
      writeHands(tx,t,hands,t.hands);
      return {state:game.state};
    }); }
  }

  case 'draw': {
    const ref=gameRef();
    return reply(await runTx(async tx=>{
      const now=Date.now();
      const t=await load(tx,ref,{hands:true});
      const game=t.game, me=mine(t);
      onTurn(game,me);
      if(game.vote)refuse('voting');
      const hands=[...t.hands];
      game.seats[me]={...game.seats[me],missed:0};
      if(!drawOrPass(game,hands,t.secret,me,now))advance(game,now);
      tx.set(ref,saved(game));
      tx.set(t.privateRef,kept(t.secret));
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
    await isWord();
    return reply(await runTx(async tx=>{
      const now=Date.now();
      const t=await load(tx,ref,{hands:true});
      const game=t.game, caller=mine(t);
      if(game.state!=='playing')return {state:game.state};
      if(Number(data.turn)!==game.turn.number)return {state:game.state,turn:game.turn.number};
      // The clock stands still while the table votes; `settle` gives it back.
      if(game.vote)return {state:game.state,voting:true,retryInMs:Math.max(1_000,game.vote.endsAt+tableRules.graceMs-now)};
      const seatIndex=game.turn.seat;
      // A bot's turn: played when its moment comes (bots.js), whoever calls.
      if(game.seats[seatIndex].bot) {
        const due=game.turn.botAt ?? game.turn.startedMs;
        if(now<due)return {state:game.state,retryInMs:due-now};
        return botTurn(tx,ref,t,now);
      }
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
        tallied.add('penalties');
      } else {
        over=drawOrPass(game,hands,t.secret,seatIndex,now,'timeout-draw');
      }
      if(!over) {
        const missed=own ? 0 : (game.seats[seatIndex].missed ?? 0)+1;
        game.seats[seatIndex]={...game.seats[seatIndex],missed};
        if(missed>=tableRules.maxMissed) {
          game.seats[seatIndex]={...game.seats[seatIndex],left:true,dropped:true};
          log(game,{type:'dropped',seat:seatIndex},now);
          tallied.add('dropped');
          over=lastOneStanding(game,hands,now);
        }
      }
      if(!over)advance(game,now);
      tx.set(ref,saved(game));
      tx.set(t.privateRef,kept(t.secret));
      writeHands(tx,t,hands,t.hands);
      return {state:game.state};
    }));
  }

  // In the lobby: out of the seat (the next player hosts; the last one out closes it). In a game: out for good, and
  // the turn moves on if it was theirs. After the end: only marks them gone, for "עוד משחק".
  case 'leave': {
    const ref=gameRef();
    return reply(await runTx(async tx=>{
      const now=Date.now();
      const t=await load(tx,ref,{hands:true});
      const game=t.game;
      const activeRef=playerRef(player);
      const active=await tx.get(activeRef);
      if(active.get('activeGameId')===ref.id)
        tx.update(activeRef,{activeGameId:null,activeGameUntilMs:0});
      if(t.me<0)return {state:game.state};
      const me=t.me;
      const invite=root.collection('invites').doc(game.code);
      if(game.state==='lobby') {
        const seats=game.seats.filter((s,i)=>i!==me).map(unready);
        const handIds=t.secret.handIds.filter((h,i)=>i!==me);
        const humans=seats.filter(s=>!s.bot);
        // The next human hosts; a table left with bots only closes.
        if(!humans.length) {
          tx.update(ref,{seats,state:'cancelled',discoverable:false,finishedMs:now,...stamp()});
          tx.delete(invite);
          count('lobbiesClosed');
        } else {
          tx.update(ref,{seats,host:game.host===player ? humans[0].id : game.host,
            discoverable:discoverable({...game,seats}),...stamp()});
        }
        tx.set(t.privateRef,kept({...t.secret,handIds}));
        return {state:humans.length ? 'lobby' : 'cancelled'};
      }
      if(game.state==='playing') {
        if(game.seats[me].left)return {state:game.state};
        game.seats[me]={...game.seats[me],left:true};
        log(game,{type:'left',seat:me},now);
        count('leftMidGame');
        const hands=[...t.hands];
        if(!lastOneStanding(game,hands,now) && game.turn.seat===me)advance(game,now);
        tx.set(ref,saved(game));
        return {state:game.state};
      }
      if(game.state==='finished' && !game.seats[me].left) {
        game.seats[me]={...game.seats[me],left:true};
        tx.update(ref,{seats:game.seats,...stamp()});
      }
      return {state:game.state};
    }));
  }

  // The app went to the background, or came back: the others see "לא באפליקציה". The clock does not stop.
  case 'away': case 'back': {
    const ref=gameRef();
    return reply(await runTx(async tx=>{
      const t=await load(tx,ref);
      const me=mine(t);
      const away=data.action==='away';
      if(t.game.seats[me].away===away || !['lobby','playing'].includes(t.game.state))return {state:t.game.state};
      const seats=t.game.seats.map((s,i)=>i===me ? {...s,away} : s);
      tx.update(ref,{seats,...stamp()});
      return {state:t.game.state};
    }));
  }

  // "בקשו מהשולחן לאשר": the player on turn, once a turn, asks the others to accept words the dictionary lacks. The
  // turn's clock stops for the vote and takes up where it left off when the vote is settled.
  case 'ask': {
    const ref=gameRef();
    await isWord();
    return reply(await runTx(async tx=>{
      const now=Date.now();
      const t=await load(tx,ref);
      const game=t.game, me=mine(t);
      onTurn(game,me);
      if(game.vote)refuse('voting');
      if(game.turn.asked)throw new HttpsError('failed-precondition','asked');
      // Only humans vote; against bots only there is nobody to ask.
      if(!voters({...game,vote:{by:me}}).length)throw new HttpsError('failed-precondition','no-voters');
      if(now>game.turn.endsAt)refuse('stale','Time is up');
      let words;
      try { words=readAsked(data.words,wordCheck,game.accepted ?? []); }
      catch(e) { throw new HttpsError('invalid-argument',e.message); }
      const left=Math.max(5_000,game.turn.endsAt-now);
      const endsAt=now+tableRules.voteMs;
      game.vote={by:me,words,votes:{},endsAt,left,turn:game.turn.number};
      // The clock cannot run out while the table votes: it is set to the vote's end plus what was left.
      game.turn={...game.turn,asked:true,endsAt:endsAt+left};
      log(game,{type:'ask',seat:me,words:words.map(w=>w.text)},now);
      count('asks');
      count('askedWords',words.length);
      tx.set(ref,saved(game));
      return {endsAt};
    }));
  }

  // A vote on every asked word at once: `accept` lists the keys this player accepts; the rest are "no". A vote can
  // be changed until the time is up. When everyone has voted, the vote is settled at once.
  case 'vote': {
    const ref=gameRef();
    return reply(await runTx(async tx=>{
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
    return reply(await runTx(async tx=>{
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

  // A friend asked to this lobby: the invitation lands in their inbox with the code, and their app shows it wherever
  // they are. Anyone seated may invite, while the table is still a lobby with a free seat. A friend the server has never
  // seen (no table yet) cannot be reached.
  case 'inviteFriend': {
    const me=await details();
    await register(me);
    const ref=gameRef();
    const friend=data.friend;
    if(typeof friend!=='string' || !/^[0-9a-f]{64}$/.test(friend) || friend===player)
      throw new HttpsError('invalid-argument','Invalid friend');
    return reply(await runTx(async tx=>{
      const now=Date.now();
      const t=await load(tx,ref);
      mine(t);
      const game=t.game;
      if(game.state!=='lobby')throw new HttpsError('failed-precondition','started');
      if(game.seats.some(s=>s.id===friend))throw new HttpsError('failed-precondition','seated');
      if((game.kicked ?? []).includes(friend))throw new HttpsError('failed-precondition','removed');
      if(game.seats.length>=maxSeats(game))throw new HttpsError('failed-precondition','full');
      const [friendDoc,meDoc]=await tx.getAll(playerRef(friend),playerRef(player));
      const inbox=friendDoc.get('inbox');
      if(!friendDoc.exists || typeof inbox!=='string')throw new HttpsError('not-found','unknown-friend');
      const recent=(meDoc.get('invitesSent') ?? []).filter(ms=>ms>now-60_000);
      if(recent.length>=inviteRules.perMinute)throw new HttpsError('resource-exhausted','too-many');
      const inboxRef=root.collection('inboxes').doc(inbox);
      const old=((await tx.get(inboxRef)).get('invites') ?? []).filter(i=>i.expiresMs>now && i.gameId!==ref.id);
      const invite={id:randomBytes(9).toString('base64url'),gameId:ref.id,code:game.code,from:me.nickname,fromId:player,
        players:game.seats.length,sentMs:now,expiresMs:game.expiresMs ?? now+tableRules.lobbyMs};
      tx.set(inboxRef,{invites:[...old,invite].slice(-inviteRules.kept),updatedMs:now,
        expireAt:Timestamp.fromMillis(invite.expiresMs+24*60*60_000)});
      tx.set(playerRef(player),{invitesSent:[...recent,now]},{merge:true});
      count('friendInvites');
      return {sent:true};
    }));
  }

  // Bots in the lobby (README.md, "Bots"), the host's to add, remove and set the level of (1–5). A bot takes a seat
  // like a player, is always ready, never pays and never collects. Each change clears the players' readiness.
  case 'addBot': case 'removeBot': case 'botLevel': {
    const ref=gameRef();
    if(data.action!=='removeBot' && data.level!==undefined && !validLevel(data.level))
      throw new HttpsError('invalid-argument','Invalid level');
    if(data.action!=='addBot' && (typeof data.bot!=='string' || !/^bot-[0-9a-f]{12}$/.test(data.bot)))
      throw new HttpsError('invalid-argument','Invalid bot');
    return reply(await runTx(async tx=>{
      const now=Date.now();
      const t=await load(tx,ref);
      const game=t.game;
      if(game.host!==player)throw new HttpsError('permission-denied','Only the host');
      if(game.state!=='lobby')refuse('not-playing');
      if(data.action==='addBot') {
        if(game.seats.length>=maxSeats(game))throw new HttpsError('failed-precondition','full');
        const bot=botSeat(game.seats,data.level ?? botRules.level,now,newBotId());
        const seats=[...game.seats.map(unready),bot];
        tx.update(ref,{seats,discoverable:discoverable({...game,seats}),...stamp()});
        tx.set(t.privateRef,kept({...t.secret,handIds:[...t.secret.handIds,newHandId()]}));
        count('botsAdded');
        return {bot:bot.id};
      }
      const index=game.seats.findIndex(s=>s.bot && s.id===data.bot);
      if(index<0)throw new HttpsError('not-found','No such bot');
      if(data.action==='removeBot') {
        const seats=game.seats.filter((s,i)=>i!==index).map(unready);
        tx.update(ref,{seats,discoverable:discoverable({...game,seats}),...stamp()});
        tx.set(t.privateRef,kept({...t.secret,handIds:t.secret.handIds.filter((h,i)=>i!==index)}));
        return {bot:data.bot};
      }
      if(data.level===undefined)throw new HttpsError('invalid-argument','Invalid level');
      if(game.seats[index].level===data.level)return {bot:data.bot};
      tx.update(ref,{seats:game.seats.map((s,i)=>i===index ? {...s,level:data.level} : unready(s)),...stamp()});
      return {bot:data.bot};
    }));
  }

  // The host removes a player from the lobby (README.md, "Removing a player"): their seat goes, and the table keeps
  // their id in `kicked`, so the code no longer lets them in. Their phone sees itself gone and in `kicked`, and says
  // so. Only in the lobby: a game being played is left only by the player.
  case 'kick': {
    const ref=gameRef();
    if(typeof data.player!=='string' || !/^[0-9a-f]{64}$/.test(data.player))throw new HttpsError('invalid-argument','Invalid player');
    return reply(await runTx(async tx=>{
      const t=await load(tx,ref);
      const game=t.game;
      if(game.host!==player)throw new HttpsError('permission-denied','Only the host');
      if(game.state!=='lobby')refuse('not-playing');
      if(data.player===player)throw new HttpsError('invalid-argument','Not yourself');
      const out=kickSeat(game.seats,t.secret.handIds,game.kicked,data.player,game.host);
      if(!out)return {removed:false};
      const seats=out.seats.map(unready);
      tx.update(ref,{seats,kicked:out.kicked,discoverable:discoverable({...game,seats}),...stamp()});
      tx.set(t.privateRef,kept({...t.secret,handIds:out.handIds}));
      count('kicks');
      return {removed:true};
    }));
  }

  // "עוד משחק" after the end: the first to ask opens a new lobby with the same settings and points the old table to
  // it; everyone after joins that lobby.
  case 'again': {
    const me=await details();
    await register(me);
    const ref=gameRef();
    const tuning=await tuningFor(db,env);
    return reply(await runTx(async tx=>{
      const now=Date.now();
      const t=await load(tx,ref);
      mine(t);
      if(t.game.state!=='finished')throw new HttpsError('failed-precondition','not-finished');
      if(t.game.next) {
        const nextRef=games.doc(t.game.next);
        const n=await load(tx,nextRef);
        if(n.me>=0) {
          await reserveActive(tx,nextRef.id,now);
          return {gameId:nextRef.id,handId:n.secret.handIds[n.me],code:n.game.code};
        }
        if((n.game.kicked ?? []).includes(player))throw new HttpsError('permission-denied','removed');
        if(n.game.state!=='lobby')throw new HttpsError('failed-precondition','started');
        if(n.game.seats.length>=maxSeats(n.game))throw new HttpsError('failed-precondition','full');
        covers(n.game.settings.stake);
        const handId=newHandId();
        const seats=[...n.game.seats.map(unready),seat(player,me,now,managed)];
        await reserveActive(tx,nextRef.id,now);
        tx.update(nextRef,{seats,discoverable:discoverable({...n.game,seats}),...stamp()});
        tx.set(n.privateRef,kept({...n.secret,handIds:[...n.secret.handIds,handId]}));
        return {gameId:nextRef.id,handId,code:n.game.code};
      }
      // The same settings; the same price when this player can still pay it, otherwise the nearest they can.
      const stake=chooseStake(tuning,t.game.settings.stake ?? 0,balance);
      if(stake==null)throw new HttpsError('failed-precondition',balance===undefined ? 'update' : 'diamonds',
        {stake:t.game.settings.stake,balance});
      const lobby=await openLobby(tx,me,{...t.game.settings,stake},now,ref.id,(t.game.round ?? 1)+1,
        t.game.seats.filter(s=>s.bot));
      tx.update(ref,{next:lobby.gameId,...stamp()});
      return lobby;
    }));
  }
  }
});

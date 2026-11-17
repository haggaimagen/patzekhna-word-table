import {test} from 'node:test';
import assert from 'node:assert/strict';
import {expiredSeat,finishTable,staleTurn,tableLeaseMs,visibleRoom} from '../src/tableLifecycle.js';

const now=1_800_000_000_000;
const room=(state='playing',seats=[{id:'host',left:false,bot:false}])=>({
  state,visibility:'public',discoverable:true,host:'host',seats,
  expiresMs:now+30_000,turn:{number:3,seat:0,endsAt:now-1_000},
  settings:{stake:0,turnSeconds:30},log:[],startedMs:now-60_000,
});

test('old clients stay visible during a normal turn, then a stopped turn disappears',()=>{
  const game=room();
  assert.equal(visibleRoom(game,now),true);
  game.turn.endsAt=now-11*60_000;
  assert.equal(staleTurn(game,now),true);
  assert.equal(visibleRoom(game,now),false);
});

test('new clients keep a table lease and an expired only-human room is hidden',()=>{
  const seat={id:'host',bot:false,left:false,leaseManaged:true,tableUntilMs:now+tableLeaseMs};
  const game=room('playing',[seat,{id:'bot',bot:true,left:false}]);
  assert.equal(visibleRoom(game,now),true);
  seat.tableUntilMs=now-1;
  assert.equal(expiredSeat(seat,now),true);
  assert.equal(visibleRoom(game,now),false);
});

test('full waiting room still requires an online host',()=>{
  const game=room('lobby',[{id:'host',bot:false,left:false},{id:'bot',bot:true,left:false}]);
  assert.equal(visibleRoom(game,now,true),true);
  assert.equal(visibleRoom(game,now,false),false);
});

test('abandoning a bot-only game finishes it without a pot',()=>{
  const game={...room('playing',[{id:'host',left:true,bot:false},{id:'bot',left:false,bot:true}]),botTable:true};
  finishTable(game,[[],[]],null,'abandoned',now);
  assert.equal(game.state,'finished');
  assert.equal(game.discoverable,false);
  assert.equal(game.result.reason,'abandoned');
  assert.equal(game.result.pot,0);
});

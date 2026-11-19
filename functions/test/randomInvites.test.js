// Random invitations (src/randomInvites.js, README.md "Random invitations"): who may be asked, the receiver's limits,
// and the rows of the host's panel.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomRules,ineligible,afterSent,afterAccepted,settledRow,pendingRows,freeSeats,retryable,shuffled,optOut,
  validSlot,validInvite} from '../src/randomInvites.js';
import {onlineByLease} from '../src/presence.js';
import {tableTuning} from '../src/table.js';

const now=1_800_000_000_000;
const day='2027-01-15';
// An online player of a current app, free, never asked.
const ready=(over={})=>({id:'p1',inbox:'i'.repeat(64),onlineUntilMs:now+20_000,randomVersion:1,randomBusy:false,
  balance:100,...over});
const why=(over,rules={})=>ineligible(ready(over),now,{day,...rules});

test('online is the presence lease, behind one helper',()=>{
  assert.equal(onlineByLease({onlineUntilMs:now+1},now),true);
  assert.equal(onlineByLease({onlineUntilMs:now},now),false);
  assert.equal(onlineByLease({},now),false);
  assert.equal(onlineByLease(undefined,now),false);
});

test('a free online player of a current app may be asked',()=>{
  assert.equal(why({}),null);
});

test('who may not be asked',()=>{
  assert.equal(ineligible(null,now,{day}),'unknown');
  assert.equal(why({},{excluded:new Set(['p1'])}),'excluded','the host, the seated, the removed, the already asked');
  assert.equal(why({onlineUntilMs:now-1}),'offline');
  assert.equal(why({randomVersion:undefined}),'old-app','an app from before the feature never sees the invitation');
  assert.equal(why({inbox:undefined}),'no-inbox');
  assert.equal(why({randomBusy:true}),'busy','a table or a duel on screen');
  assert.equal(why({lobbyUntilMs:now+5_000}),'lobby','in רמילים\'s lobby');
  assert.equal(why({lobbyUntilMs:now-1}),null,'an old lobby lease does not count');
  assert.equal(why({activeGameId:'g',activeGameUntilMs:now+5_000}),'table','seated at a table');
  assert.equal(why({activeGameId:'g',activeGameUntilMs:now-1}),null);
  assert.equal(why({randomOff:true}),'never');
  assert.equal(why({randomOffUntilMs:now+1}),'snoozed');
  assert.equal(why({randomOffUntilMs:now-1}),null,'a 24-hour pause ends');
});

test('the room\'s price must be covered by the receiver\'s balance',()=>{
  assert.equal(why({balance:50},{stake:50}),null);
  assert.equal(why({balance:49},{stake:50}),'diamonds');
  assert.equal(why({balance:undefined},{stake:20}),'diamonds','no balance known, no priced invitation');
  assert.equal(why({balance:undefined},{stake:0}),null,'a free room needs no balance');
});

test('one invitation per 10 minutes and 5 a day, reset by accepting',()=>{
  assert.equal(why({randomLastMs:now-randomRules.receiverGapMs+1}),'cooldown');
  assert.equal(why({randomLastMs:now-randomRules.receiverGapMs}),null);
  assert.equal(why({randomDay:day,randomDayCount:5}),'daily');
  assert.equal(why({randomDay:day,randomDayCount:4}),null);
  assert.equal(why({randomDay:'2027-01-14',randomDayCount:5}),null,'a new day starts at zero');
  assert.deepEqual(afterSent({randomDay:day,randomDayCount:2},now,day),{randomDay:day,randomDayCount:3,randomLastMs:now});
  assert.deepEqual(afterSent({randomDay:'2027-01-14',randomDayCount:5},now,day),{randomDay:day,randomDayCount:1,randomLastMs:now});
  const accepted={randomDay:day,randomDayCount:5,randomLastMs:now,...afterAccepted()};
  assert.equal(ineligible(ready(accepted),now,{day}),null,'accepting clears both limits');
});

test('the host\'s rows: pending, then no answer after 30 seconds',()=>{
  const row={slot:'r00000001',nickname:'א',status:'pending',sentMs:now,expiresMs:now+randomRules.answerMs};
  assert.equal(settledRow(row,now+randomRules.answerMs).status,'pending');
  assert.equal(settledRow(row,now+randomRules.answerMs+1).status,'timeout');
  assert.equal(settledRow({...row,status:'joined'},now+60_000).status,'joined');
  assert.equal(pendingRows([row,{...row,slot:'r2',status:'declined'}],now).length,1);
  assert.equal(pendingRows([row],now+randomRules.answerMs+1).length,0);
  assert.equal(retryable({status:'declined'}),true);
  assert.equal(retryable({status:'timeout'}),true);
  assert.equal(retryable({status:'missed'}),true);
  assert.equal(retryable({status:'pending'}),false);
  assert.equal(retryable({status:'joined'}),false);
});

test('free seats leave room for the invitations still waiting',()=>{
  const game={settings:{maxPlayers:4},seats:[{id:'h'}]};
  const pending={status:'pending',expiresMs:now+10_000};
  assert.equal(freeSeats(game,[],now),3);
  assert.equal(freeSeats(game,[pending,pending],now),1);
  assert.equal(freeSeats(game,[{...pending,expiresMs:now-1}],now),3,'an unanswered invitation frees its seat');
  assert.equal(freeSeats({settings:{maxPlayers:2},seats:[{id:'h'},{id:'g'}]},[],now),0);
});

test('shuffling keeps everyone, in a random order',()=>{
  const list=[1,2,3,4,5];
  const out=shuffled(list,()=>0);
  assert.deepEqual([...out].sort(),list);
  assert.notDeepEqual(out,list);
  assert.deepEqual(list,[1,2,3,4,5],'the input is untouched');
});

test('the player\'s switch, and the ids the actions take',()=>{
  assert.deepEqual(optOut({randomOff:true},now),{off:true,untilMs:0});
  assert.deepEqual(optOut({randomOffUntilMs:now+5},now),{off:false,untilMs:now+5});
  assert.deepEqual(optOut({randomOffUntilMs:now-5},now),{off:false,untilMs:0});
  assert.deepEqual(optOut(undefined,now),{off:false,untilMs:0});
  assert.equal(validSlot('r0123abcd'),true);
  assert.equal(validSlot('r0123abc'),false);
  assert.equal(validInvite('abcdefghijkl'),true);
  assert.equal(validInvite('abc'),false);
});

test('the cap a waiting room has is StageAdmin\'s, 15 by default, 0 for off',()=>{
  assert.equal(tableTuning(null).randomPerTable,15);
  assert.equal(tableTuning({wordTable:{randomPerTable:8}}).randomPerTable,8);
  assert.equal(tableTuning({wordTable:{randomPerTable:0}}).randomPerTable,0,'off');
  assert.equal(tableTuning({wordTable:{randomPerTable:101}}).randomPerTable,15,'out of range: the default');
  assert.equal(tableTuning({wordTable:{randomPerTable:'5'}}).randomPerTable,15);
  assert.equal(tableTuning({wordTable:{randomPerTable:4,houseCut:500}}).randomPerTable,4,'bad prices leave the cap');
  assert.equal(tableTuning({economy:{enabled:false},wordTable:{randomPerTable:6}}).randomPerTable,6,'diamonds off: still set');
});

test('the lobby shows what a player wears: well-formed ids only',async()=>{
  const {submittedLook,lookEntry}=await import('../src/look.js');
  assert.deepEqual(submittedLook({badge:'star',nameColor:'sunset-2'}),{badge:'star',nameColor:'sunset-2'});
  assert.deepEqual(submittedLook({badge:'Bad Id!',nameColor:null}),{badge:null,nameColor:null});
  assert.equal(submittedLook(undefined),null,'builds from before send none');
  assert.deepEqual(lookEntry({badge:'star',nameColor:null}),{badge:'star'});
  assert.deepEqual(lookEntry(undefined),{});
});

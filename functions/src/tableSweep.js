// Firestore cannot run turn clocks by itself. This sweep closes tables whose only active humans stopped renewing
// their table leases, plus older clients' tables whose turn has been stuck well beyond its deadline.
import {getFirestore,FieldValue,Timestamp} from 'firebase-admin/firestore';
import {onSchedule} from 'firebase-functions/v2/scheduler';
import {botRules,thinkMs} from './bots.js';
import {tableRules} from './table.js';
import {advanceAfterLeave,expiredSeat,finishTable,staleTurn} from './tableLifecycle.js';
import {newTally,statsDay} from './stats.js';

const keepMs=30*24*60*60_000;
const stamp=now=>({updatedAt:FieldValue.serverTimestamp(),expireAt:Timestamp.fromMillis(now+keepMs)});
const saved=game=>({...game,...stamp(Date.now())});
const botClock=(game,seat,startedMs)=>({botAt:startedMs+botRules.lookMs,
  botThink:startedMs+Math.max(botRules.lookMs+1_000,thinkMs(game.seats[seat].level,game.settings.turnSeconds))});

export async function sweepGame(db,env,ref) {
  await db.runTransaction(async tx=>{
    const doc=await tx.get(ref);
    if(!doc.exists)return;
    const game=doc.data();
    const now=Date.now();
    const expired=game.seats?.map((seat,i)=>expiredSeat(seat,now) ? i : -1).filter(i=>i>=0) ?? [];
    const oldTurn=staleTurn(game,now);
    if(game.state==='lobby') {
      if(game.expiresMs>now && !expired.length)return;
      const privateRef=ref.collection('private').doc('state');
      const secret=(await tx.get(privateRef)).data();
      const removed=new Set(expired);
      const seats=(game.seats ?? []).filter((_,i)=>!removed.has(i)).map(seat=>seat.bot ? seat : {...seat,ready:false});
      const humans=seats.filter(seat=>!seat.bot);
      const tally=newTally();
      if(secret && removed.size)tx.set(privateRef,{...secret,
        handIds:secret.handIds.filter((_,i)=>!removed.has(i)),expireAt:Timestamp.fromMillis(now+keepMs)});
      if(game.expiresMs<=now || !humans.length) {
        tx.update(ref,{seats,state:'cancelled',discoverable:false,finishedMs:now,...stamp(now)});
        tx.delete(db.collection('tables').doc(env).collection('invites').doc(game.code));
        tally.add('lobbiesClosed');
      } else {
        tx.update(ref,{seats,host:humans.some(seat=>seat.id===game.host) ? game.host : humans[0].id,
          ...stamp(now)});
      }
      if(tally.size)tx.set(db.collection('tableStats').doc(env).collection('days').doc(statsDay()),
        {day:statsDay(),updatedMs:now,...tally.update(n=>FieldValue.increment(n))},{merge:true});
      return;
    }
    if(game.state!=='playing' || (!expired.length && !oldTurn))return;
    const privateRef=ref.collection('private').doc('state');
    const secret=(await tx.get(privateRef)).data();
    if(!secret || secret.handIds?.length!==game.seats.length)throw new Error(`Missing hands for ${ref.path}`);
    const handRefs=secret.handIds.map(id=>ref.collection('hands').doc(id));
    const handDocs=await tx.getAll(...handRefs);
    const hands=handDocs.map(doc=>doc.get('tiles') ?? []);
    const leaving=oldTurn ? game.seats.map((seat,i)=>!seat.bot && !seat.left ? i : -1).filter(i=>i>=0) : expired;
    if(!leaving.length)return;
    const tally=newTally();
    for(const i of leaving) {
      game.seats[i]={...game.seats[i],left:true,dropped:true};
      game.log=[...(game.log ?? []),{type:'dropped',seat:i,turn:game.turn?.number ?? 0,at:now}]
        .slice(-tableRules.logSize);
      tally.add('dropped');
    }
    const inGame=game.seats.filter(seat=>!seat.left);
    if(inGame.length<2 || !inGame.some(seat=>!seat.bot))
      finishTable(game,hands,null,'abandoned',now,(key,n=1)=>tally.add(key,n));
    else advanceAfterLeave(game,now,botClock);
    tx.set(ref,saved(game));
    if(tally.size)tx.set(db.collection('tableStats').doc(env).collection('days').doc(statsDay()),
      {day:statsDay(),updatedMs:now,...tally.update(n=>FieldValue.increment(n))},{merge:true});
  });
}

export const sweepTables=onSchedule({schedule:'every 1 minutes',region:'europe-west1',
  memory:'512MiB',maxInstances:1,timeoutSeconds:540},async()=>{
  const db=getFirestore();
  for(const env of ['development','production'])for(const state of ['lobby','playing']) {
    const games=db.collection('tables').doc(env).collection('games');
    let cursor=null;
    do {
      let query=games.where('state','==',state).limit(200);
      if(cursor)query=query.startAfter(cursor);
      const page=await query.get();
      for(const doc of page.docs) {
        const game=doc.data(),now=Date.now();
        if((state==='lobby' && game.expiresMs>now && !game.seats?.some(seat=>expiredSeat(seat,now))) ||
           (state==='playing' && !staleTurn(game,now) && !game.seats?.some(seat=>expiredSeat(seat,now))))continue;
        try { await sweepGame(db,env,doc.ref); }
        catch(error) { console.error('table sweep failed',env,doc.id,error); }
      }
      cursor=page.docs.at(-1) ?? null;
      if(page.empty || page.size<200)break;
    } while(cursor);
  }
});

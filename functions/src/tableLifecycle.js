// A room lease belongs to the table on screen, not to the app-wide online indicator. Older clients do not send
// table pulses, so an overdue turn is also a bounded fallback until the next client releases are installed.
import {finalScores,handValue,nextSeat,payouts,tableRules} from './table.js';
import {statsKey} from './stats.js';

export const tableLeaseMs=5*60_000;
export const stalledTurnMs=10*60_000;

export const staleTurn=(game,now)=>game.state==='playing' &&
  Number.isFinite(game.turn?.endsAt) && game.turn.endsAt+stalledTurnMs<=now;

export const expiredSeat=(seat,now)=>!seat.bot && !seat.left && seat.leaseManaged===true &&
  Number.isFinite(seat.tableUntilMs) && seat.tableUntilMs<=now;

// Browsing never waits for the scheduled sweep to hide a game that cannot be active anymore.
export function visibleRoom(game,now,hostOnline=true) {
  if(game.visibility!=='public' || !['lobby','playing'].includes(game.state))return false;
  if(game.state==='lobby') {
    const host=game.seats.find(seat=>seat.id===game.host);
    return game.expiresMs>now && hostOnline && host && !host.away && !expiredSeat(host,now);
  }
  if(staleTurn(game,now))return false;
  return game.seats.some(seat=>!seat.bot && !seat.left && !expiredSeat(seat,now));
}

export function advanceAfterLeave(game,now,botClock) {
  if(!game.turn || !game.seats[game.turn.seat]?.left)return;
  const seat=nextSeat(game.seats,game.turn.seat);
  game.turn={number:game.turn.number+1,seat,startedMs:now,endsAt:now+game.settings.turnSeconds*1_000};
  if(game.seats[seat]?.bot)Object.assign(game.turn,botClock(game,seat,now));
  game.draft=null;
  game.vote=null;
}

export function finishTable(game,hands,winner,reason,now,count=()=>{}) {
  const values=game.seats.map((seat,i)=>handValue(hands[i] ?? []));
  const result=finalScores(game.seats,values,winner);
  const pay=payouts(game.seats,game.settings.stake ?? 0,game.houseCut ?? 0,result.winner,
    {values,botTable:game.botTable===true});
  game.seats=game.seats.map((seat,i)=>({...seat,score:result.scores[i],value:values[i]}));
  game.state='finished';
  game.discoverable=false;
  game.result={winner:result.winner,reason,values,pot:pay.pot,payouts:pay.payouts,taker:pay.taker};
  if(result.winner!=null && game.seats[result.winner]?.bot)count('botWins');
  if(pay.pot) {
    count('diamondsCut',pay.cut);
    count('diamondsPaidOut',pay.payouts.reduce((sum,n)=>sum+n,0));
  }
  game.finishedMs=now;
  game.draft=null;
  game.log=[...(game.log ?? []),{type:'end',seat:result.winner,reason,turn:game.turn?.number ?? 0,at:now}]
    .slice(-tableRules.logSize);
  count('gamesFinished');
  count(`ends.${statsKey(reason)}`);
  if(game.startedMs)count('durationMsSum',Math.max(0,now-game.startedMs));
  count('turnsSum',game.turn?.number ?? 0);
}

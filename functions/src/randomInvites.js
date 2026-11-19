// Random invitations (README.md, "Random invitations"): a host asks up to three online players they don't know to
// their waiting room. The rules here are pure; tableCallable.js (`inviteRandom`, `answerRandom`, `randomSetting`) reads
// and writes the documents.
//
// Where things live:
//   tables/{env}/games/{id}               `randomInvites`: one row per invited player for the host's panel (slot,
//                                         nickname, status, sentMs, expiresMs, answeredMs), and `randomInvitedMs`, the
//                                         last batch, for the 30-second wait. No player ids: anyone at the table reads it.
//   tables/{env}/games/{id}/private/state `random`: {slot: {player, invite}}, who holds which slot's invitation, and
//                                         `randomTried`: every player this table has invited, never asked twice.
//   tables/{env}/players/{id}             the receiver's limits and choices (`randomDay`, `randomDayCount`,
//                                         `randomLastMs`, `randomOff`, `randomOffUntilMs`) and what their presence says
//                                         (`randomVersion`, `randomBusy`, `balance`). Server only.
//   tables/{env}/inboxes/{inbox}          `random`: the invitation itself, beside the friends' `invites`, read by the
//                                         receiver's existing inbox listener. Older apps never read the field.
import {onlineByLease} from './presence.js';
import {maxSeats} from './table.js';

export const randomRules={
  perBatch:3,
  // The host's button: once every 30 seconds.
  cooldownMs:30_000,
  // A receiver has 30 seconds to answer; a join a few seconds late still counts.
  answerMs:30_000,
  graceMs:5_000,
  // A receiver gets at most one random invitation per 10 minutes and 5 a day (Israel day). Accepting one resets both.
  receiverGapMs:10*60_000,
  receiverPerDay:5,
  snoozeMs:24*60*60_000,
  // A waiting room asks at most this many players in all, however often the host retries: StageAdmin's
  // `wordTable.randomPerTable` (table.js, `randomPerTable`), 15 by default, 0 for off.
  // How many online players one press looks through.
  candidates:60,
  // The first app version of this feature, sent with presence as `randomInvites`.
  version:1,
};

export const answers=['accept','decline','snooze','never','timeout'];
export const validSlot=slot=>typeof slot==='string' && /^r[0-9a-f]{8}$/.test(slot);
export const validInvite=id=>typeof id==='string' && /^[A-Za-z0-9_-]{12}$/.test(id);

/** Why this player record may not get a random invitation now, or null when it may. `excluded` holds the host, the
 *  seated, the removed and everyone this table already asked. */
export function ineligible(record,now,{day,stake=0,excluded=new Set()}) {
  if(!record)return 'unknown';
  if(excluded.has(record.id))return 'excluded';
  if(!onlineByLease(record,now))return 'offline';
  if(!((record.randomVersion ?? 0)>=randomRules.version))return 'old-app';
  if(typeof record.inbox!=='string')return 'no-inbox';
  if(record.randomBusy===true)return 'busy';
  if((record.lobbyUntilMs ?? 0)>now)return 'lobby';
  if(record.activeGameId && (record.activeGameUntilMs ?? 0)>now)return 'table';
  if(record.randomOff===true)return 'never';
  if((record.randomOffUntilMs ?? 0)>now)return 'snoozed';
  if(stake>0 && !(Number.isInteger(record.balance) && record.balance>=stake))return 'diamonds';
  if((record.randomLastMs ?? 0)>now-randomRules.receiverGapMs)return 'cooldown';
  if(record.randomDay===day && (record.randomDayCount ?? 0)>=randomRules.receiverPerDay)return 'daily';
  return null;
}

/** The receiver's counters after one more invitation. */
export const afterSent=(record,now,day)=>({randomDay:day,
  randomDayCount:(record.randomDay===day ? record.randomDayCount ?? 0 : 0)+1,randomLastMs:now});
/** Accepting an invitation clears the day's count and the 10-minute wait. */
export const afterAccepted=()=>({randomDayCount:0,randomLastMs:0});

/** A row as the host's panel should show it: a pending invitation past its time has had no answer. */
export const settledRow=(row,now)=>row.status==='pending' && now>row.expiresMs ? {...row,status:'timeout'} : row;
export const pendingRows=(rows,now)=>rows.filter(r=>r.status==='pending' && now<=r.expiresMs);

/** Seats nobody holds and no live invitation is waiting for. */
export const freeSeats=(game,rows,now)=>maxSeats(game)-game.seats.length-pendingRows(rows,now).length;

/** Rows the host may retry with another player. */
export const retryable=row=>['declined','timeout','missed'].includes(row?.status);

/** Fisher–Yates, so every online player has the same chance. */
export function shuffled(list,random=Math.random) {
  const out=[...list];
  for(let i=out.length-1;i>0;i--) {
    const j=Math.floor(random()*(i+1));
    [out[i],out[j]]=[out[j],out[i]];
  }
  return out;
}

/** Whether the player's own choice stops random invitations, for their switch: off for good, or until a moment. */
export const optOut=(record,now)=>({off:record?.randomOff===true,
  untilMs:(record?.randomOffUntilMs ?? 0)>now ? record.randomOffUntilMs : 0});

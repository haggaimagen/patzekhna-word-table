// Who is online now (README.md, "Random invitations"). Today that is the app-wide presence lease the phones renew
// every 20 s (`presence` in tableCallable.js, `onlineUntilMs` on tables/{env}/players/{id}). Every check goes
// through here, so the planned Realtime Database presence (the game's FIRESTORE_READS.md, Phase 2) replaces one file.

/** True when this player record's lease says the app is in front right now. */
export const onlineByLease=(record,now)=>(record?.onlineUntilMs ?? 0)>now;

/** Up to `limit` player records whose lease is current, as `{id, ...data}`: one query, `limit` reads at most. */
export async function onlinePlayers(root,now,limit) {
  const page=await root.collection('players').where('onlineUntilMs','>',now).orderBy('onlineUntilMs','desc')
    .limit(limit).get();
  return page.docs.map(doc=>({id:doc.id,...doc.data()}));
}

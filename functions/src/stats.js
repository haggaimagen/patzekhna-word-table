// The game's statistics, aggregated only (README.md, "Statistics"): one small document a day,
// `tableStats/{env}/days/{yyyy-mm-dd}` (Israel time), made of counters the table function adds to as games happen.
// Nothing in it is per player, so the admin tool reads a year in a few hundred documents however many people play.

const israelDay=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Jerusalem',year:'numeric',month:'2-digit',day:'2-digit'});

/** The day a moment belongs to, in Israel time: "2026-11-14". */
export const statsDay=(now=Date.now())=>israelDay.format(new Date(now));

/** Counts gathered during one transaction attempt, written once at its end. A retried attempt starts a new tally, so
 *  nothing is counted twice. Paths are dotted for the per-value maps: "players.3", "ends.empty". */
export function newTally() {
  const counts=new Map();
  return {
    add(path,n=1) { if(n)counts.set(path,(counts.get(path) ?? 0)+n); },
    get size() { return counts.size; },
    /** The nested merge-update, with [increment] wrapping each number (FieldValue.increment in the function). */
    update(increment) {
      const out={};
      for(const [path,n] of counts) {
        const parts=path.split('.');
        let node=out;
        for(const part of parts.slice(0,-1))node=node[part] ??= {};
        node[parts.at(-1)]=increment(n);
      }
      return out;
    },
  };
}

/** Values kept as map keys: only the settings' own choices and known codes, so a bad request cannot add fields. */
export const statsKey=value=>String(value).replace(/[^A-Za-z0-9_-]/g,'').slice(0,24) || 'other';

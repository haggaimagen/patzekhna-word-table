// The word table's dictionary (README.md, "The dictionary"): the list built by scripts/build_dictionary.py,
// shipped with the function source and read once per instance. Keys are Hebrew letters with final forms written as
// regular ones (שלום → שלומ), 3–15 letters, never a prefixed form.
//
// The list is built from Hspell (AGPL v3), Wikidata (CC0), Hebrew Wiktionary (CC-BY-SA 4.0) and the game's catalog.
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

export const dictionaryVersion='he-v1';

let words=null;
function load() {
  if(!words) {
    const path=fileURLToPath(new URL(`../dictionary/${dictionaryVersion}.txt.gz`,import.meta.url));
    words=new Set(gunzipSync(readFileSync(path)).toString('utf8').split('\n').filter(Boolean));
  }
  return words;
}

export const isWord=key=>load().has(key);
export const dictionarySize=()=>load().size;
/** Every key of the built list. */
export const dictionaryKeys=()=>load();

// The bots' words (bots.js): the keys people actually use, most frequent first — the built list's keys found in
// FrequencyWords' Hebrew subtitle list (scripts/build_common.py; CC-BY-SA 4.0), then the hand-added allow.txt.
// Bots pick only from here; the full list above still decides what is legal for everyone.
let common=null;
export function commonKeys() {
  if(!common) {
    const read=name=>readFileSync(fileURLToPath(new URL(`../dictionary/${name}`,import.meta.url)));
    const ranked=gunzipSync(read(`common-${dictionaryVersion}.txt.gz`)).toString('utf8').split('\n').filter(Boolean);
    const allow=read('allow.txt').toString('utf8').split('\n').map(l=>l.trim())
      .filter(l=>l && !l.startsWith('#')).map(l=>l.replace(/[ךםןףץ]/g,c=>({'ך':'כ','ם':'מ','ן':'נ','ף':'פ','ץ':'צ'})[c]));
    common={ranked,allow:allow.filter(k=>!ranked.includes(k))};
  }
  return common;
}

// The decisions made in review (the game's StageAdmin, "Words"), on top of the built list without a rebuild:
// `dictionaryLists/{env}` holds `allow` and `deny`, arrays of keys. A denied key is never a word; an allowed one
// always is. Phones read the same document, so their live check agrees.
export function withLists(lists,base=isWord) {
  const allow=new Set(Array.isArray(lists?.allow) ? lists.allow : []);
  const deny=new Set(Array.isArray(lists?.deny) ? lists.deny : []);
  return key=>!deny.has(key) && (allow.has(key) || base(key));
}

// One read a minute per instance is plenty: a decision reaches new turns within a minute.
const listCache=new Map();
export async function listsFor(db,env) {
  const hit=listCache.get(env);
  // The emulator reads every time, so tests see a change at once.
  if(hit && Date.now()-hit.at<60_000 && process.env.FUNCTIONS_EMULATOR!=='true')return hit.lists;
  const doc=await db.collection('dictionaryLists').doc(env).get();
  const lists=doc.exists ? {allow:doc.get('allow') ?? [],deny:doc.get('deny') ?? []} : {allow:[],deny:[]};
  listCache.set(env,{at:Date.now(),lists});
  return lists;
}

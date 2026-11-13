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

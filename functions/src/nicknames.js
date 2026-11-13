// Nicknames StageAdmin renamed (the game's nickname moderation). `moderation/{env}/players/{player}` holds the name
// StageAdmin gave the player and every name it replaced; it has no rule, so only the server reads it. A phone keeps
// sending the name it has, so every callable that puts a nickname on a board passes it through here: a replaced name
// becomes StageAdmin's, any other name the player picks later goes through.
import {getFirestore} from 'firebase-admin/firestore';

// Spacing and letter case do not make a replaced name new again.
export const nicknameKey=name=>typeof name==='string' ? name.normalize('NFC').trim().replace(/\s+/g,' ').toLowerCase() : '';

// What a nickname may hold : Hebrew and English letters, the digits 0–9 and single spaces,
// 1–16. No emoji or symbols, so a badge is the only way to show one beside a name. The same rule and test cases as iOS
// NicknameRule.swift and Android. Ranges, not "any letter": Unicode counts fancy alphabets as letters.
const allowed=/^[\u05D0-\u05EAa-zA-Z0-9 ]$/u;
export const NICKNAME_MAX=16;
// Anything else dropped, no space at the start, at the end or two in a row, at most 16. Empty when nothing is left.
export function cleanNickname(name) {
  if(typeof name!=='string')return '';
  let out='';
  for(const ch of name.normalize('NFC')) {
    if(!allowed.test(ch) || (ch===' ' && (out==='' || out.endsWith(' '))))continue;
    if(out.length>=NICKNAME_MAX)break;
    out+=ch;
  }
  return out.trimEnd();
}
// The animals of the automatic names (iOS AutoNickname, NicknameRule's AutoNamePool).
const animals=['ינשוף','שועל','דולפין','נמר','צב','פנדה','קיפוד','תוכי','זברה','פינגווין','סנאי','לוטרה','קואלה','פרפר','ארנב','לטאה'];
// The name a player gets when nothing of theirs is left: the same every time for the same board id (a SHA-256 in hex),
// and the same as StageAdmin's.
export function stableAutoName(player) {
  const value=parseInt(String(player ?? '').slice(0,8),16) || 0;
  return `${animals[value%animals.length]} ${10+Math.floor(value/animals.length)%990}`;
}

// A name StageAdmin replaced becomes StageAdmin's, as sent or once cleaned; any other is cleaned, and a name with nothing
// left becomes the player's automatic one. Older builds still send emoji names: they are cleaned, never refused, and
// submitScores' reply tells the phone the stored name.
export function moderatedNickname(submitted,moderation,player='') {
  const given=typeof moderation?.nickname==='string' ? cleanNickname(moderation.nickname) : '';
  const cleaned=cleanNickname(submitted);
  if(given && Array.isArray(moderation.replaced)) {
    const keys=new Set([nicknameKey(submitted),nicknameKey(cleaned)]);
    if(moderation.replaced.some(name=>keys.has(nicknameKey(name))))return given;
  }
  return cleaned || stableAutoName(player);
}

export const moderationPath=(env,player)=>`moderation/${env}/players/${player}`;

// One read, for the callables that do not read the doc in a transaction of their own: a function that applies it.
export async function nicknameFilter(env,player) {
  const doc=await getFirestore().doc(moderationPath(env,player)).get();
  const moderation=doc.exists ? doc.data() : null;
  return name=>moderatedNickname(name,moderation,player);
}

export const boardNickname=async(env,player,submitted)=>(await nicknameFilter(env,player))(submitted);

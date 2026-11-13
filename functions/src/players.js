// What every action takes from a phone, and the table's invite codes. The same rules as the game's other online
// modes: a player is known only by a key derived from the device, never by an account.

export const playerRules={maxNickname:16,codeLength:6,codeAlphabet:'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'};

// The details a seat shows: nickname, platform and app version.
export function validatePlayerDetails(data) {
  if(!['development','production'].includes(data?.environment))throw Error('Invalid environment');
  if(!['ios','android'].includes(data.platform))throw Error('Invalid platform');
  const nickname=typeof data.nickname==='string' ? data.nickname.trim() : '';
  if(!nickname || [...nickname].length>playerRules.maxNickname)throw Error('Nickname must be 1–16 characters');
  if(typeof data.appVersion!=='string' || data.appVersion.length<1 || data.appVersion.length>40)
    throw Error('Invalid app version');
  return {nickname,platform:data.platform,appVersion:data.appVersion};
}

// A lobby's code: six letters and digits, without the look-alikes 0, O, 1 and I.
export const validCode=code=>typeof code==='string' && code.length===playerRules.codeLength &&
  [...code].every(c=>playerRules.codeAlphabet.includes(c));
export const validMatchID=id=>typeof id==='string' && /^[A-Za-z0-9_-]{8,64}$/.test(id);

export function makeCode(random=Math.random) {
  const {codeAlphabet:alphabet,codeLength:length}=playerRules;
  return Array.from({length},()=>alphabet[Math.floor(random()*alphabet.length)]).join('');
}

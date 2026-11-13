// שולחן מילים, the word table (README.md): 2–4 players share one board of Hebrew words, as in rummy
// with letters. The pure rules live here, so the callable (tableCallable.js), the tests and the apps agree; Swift's
// Models/WordTable.swift holds the same tile set, the same numbers and the same checks.

// [letter, count, value]: 104 letters by how often Hebrew uses them, and 2 jokers, 106 tiles as in the original box.
// Tile ids are fixed ("t0"…"t105", in this order), so any phone knows a tile's letter from its id; a hand stays
// private because no phone but its owner's can read which ids it holds.
export const LETTERS=[
  ['א',6,1],['ב',5,2],['ג',2,3],['ד',4,2],['ה',8,1],['ו',10,1],['ז',2,4],['ח',3,3],['ט',2,4],['י',10,1],['כ',3,2],
  ['ל',7,1],['מ',7,1],['נ',5,1],['ס',2,3],['ע',3,2],['פ',3,3],['צ',2,4],['ק',3,3],['ר',6,1],['ש',5,2],['ת',6,1],
];
export const JOKERS=2;
export const ALPHABET=LETTERS.map(([l])=>l);
export const LETTER_VALUES=Object.fromEntries(LETTERS.map(([l,,v])=>[l,v]));
const FINALS={'כ':'ך','מ':'ם','נ':'ן','פ':'ף','צ':'ץ'};

export const TILES=(()=>{
  const tiles=[];
  for(const [letter,count,value] of LETTERS)for(let i=0;i<count;i++)tiles.push({id:`t${tiles.length}`,letter,value,joker:false});
  for(let i=0;i<JOKERS;i++)tiles.push({id:`t${tiles.length}`,letter:null,value:0,joker:true});
  return tiles;
})();
const TILE=new Map(TILES.map(t=>[t.id,t]));
export const tileOf=id=>TILE.get(id);

export const tableRules={minPlayers:2,maxPlayers:4,minWordLength:3,openingPoints:10,timeoutPenalty:3,jokerHandPenalty:8,
  rackSizes:[7,10,12,14,16,18,21],rackSize:14,turnSecondsOptions:[30,60,90,120],turnSeconds:60,
  colorOptions:[1,2,3,4],colors:1,colorChance:0.5,
  lobbyMs:30*60_000,startDelayMs:2_000,graceMs:2_500,maxMissed:3,maxWords:60,maxWordTiles:24,logSize:30,
  voteMs:15_000,maxAsked:3};

export function tableSettings(input={}) {
  const rackSize=tableRules.rackSizes.includes(input.rackSize) ? input.rackSize : tableRules.rackSize;
  const turnSeconds=tableRules.turnSecondsOptions.includes(input.turnSeconds) ? input.turnSeconds : tableRules.turnSeconds;
  const colors=tableRules.colorOptions.includes(input.colors) ? input.colors : tableRules.colors;
  return {rackSize,turnSeconds,colors,minWordLength:tableRules.minWordLength,openingPoints:tableRules.openingPoints,
    timeoutPenalty:tableRules.timeoutPenalty};
}

export function shuffle(list,random=Math.random) {
  const out=[...list];
  for(let i=out.length-1;i>0;i--) {
    const j=Math.floor(random()*(i+1));
    [out[i],out[j]]=[out[j],out[i]];
  }
  return out;
}

// The deal: `rackSize` tiles to each seat off the shuffled box, the rest is the pool (drawn from its end).
export function deal(seats,rackSize,random=Math.random) {
  const pool=shuffle(TILES.map(t=>t.id),random);
  const hands=Array.from({length:seats},()=>pool.splice(pool.length-rackSize,rackSize));
  return {hands,pool};
}

// Letter colours, set in the lobby (1–4). Colour 0 is the plain tile. With more than one colour, each letter has an
// even chance to be plain or to take one of the other colours, chosen evenly among them. Jokers stay plain and fit any
// colour. The result is public on the table, `{tileId: colour}` for the coloured tiles only: a colour says nothing
// about whose hand a tile is in.
export function paint(colors,random=Math.random) {
  const painted={};
  if(colors<=1)return painted;
  for(const tile of TILES) {
    if(tile.joker || random()>=tableRules.colorChance)continue;
    painted[tile.id]=1+Math.min(colors-2,Math.floor(random()*(colors-1)));
  }
  return painted;
}
export const colorOf=(id,colors={})=>tileOf(id)?.joker ? null : colors[id] ?? 0;

// The dictionary's key for a word: its letters in order (a joker as its chosen letter), with no final forms, since
// the tiles have none. wordText below is the same word as it is read.
export function wordKey(tiles,jokers={}) {
  return tiles.map(id=>{ const t=tileOf(id); return t?.joker ? (jokers[id] ?? '?') : t?.letter ?? '?'; }).join('');
}

// A word as it reads: the letters in order, a final form at the end (a joker reads as its chosen letter).
export function wordText(tiles,jokers={}) {
  const letters=tiles.map(id=>{ const t=tileOf(id); return t?.joker ? (jokers[id] ?? '?') : t?.letter ?? '?'; });
  if(letters.length>1 && FINALS[letters.at(-1)])letters[letters.length-1]=FINALS[letters.at(-1)];
  return letters.join('');
}

const tileValue=(id,jokers)=>{ const t=tileOf(id); return t.joker ? (LETTER_VALUES[jokers[id]] ?? 0) : t.value; };
// What a hand counts against its player at the end; a joker in hand costs the most.
export const handValue=hand=>hand.reduce((s,id)=>s+(tileOf(id)?.joker ? tableRules.jokerHandPenalty : tileOf(id)?.value ?? 0),0);

// A board sent by a phone, to plain words. Throws on anything malformed; the game rules come after (checkPlay).
export function readBoard(board) {
  if(!Array.isArray(board) || board.length>tableRules.maxWords)throw Error('Invalid board');
  const ids=new Set(), tiles=new Set();
  return board.map(word=>{
    if(!word || typeof word.id!=='string' || !/^[A-Za-z0-9_-]{1,24}$/.test(word.id) || ids.has(word.id))
      throw Error('Invalid board');
    ids.add(word.id);
    if(!Array.isArray(word.tiles) || !word.tiles.length || word.tiles.length>tableRules.maxWordTiles)throw Error('Invalid board');
    for(const id of word.tiles) {
      if(typeof id!=='string' || !TILE.has(id) || tiles.has(id))throw Error('Invalid board');
      tiles.add(id);
    }
    return {id:word.id,tiles:[...word.tiles]};
  });
}

// A turn as the player proposes to leave the table: the new board and the letters chosen for the jokers on it.
// `state` is the table before the turn (board, jokers, the player's hand, whether they opened, the settings).
// Returns the problems a player can fix (`errors`, empty when the turn is good) with what the turn played. Throws
// when the proposal breaks what no honest phone sends: a board tile gone, a tile that is not the player's.
export function checkPlay(state,proposal) {
  const board=readBoard(proposal?.board);
  const before=new Set(state.board.flatMap(w=>w.tiles));
  const hand=new Set(state.hand);
  const all=board.flatMap(w=>w.tiles);
  const placed=new Set(all);
  for(const id of before)if(!placed.has(id))throw Error('A board tile left the board');
  for(const id of all)if(!before.has(id) && !hand.has(id))throw Error('Not your tile');
  const played=all.filter(id=>!before.has(id));
  const errors=[];
  if(!played.length)errors.push({code:'nothing'});

  const sent=proposal.jokers && typeof proposal.jokers==='object' ? proposal.jokers : {};
  const jokers={};
  for(const id of all.filter(id=>tileOf(id).joker)) {
    const letter=sent[id];
    if(!ALPHABET.includes(letter)) { errors.push({code:'joker'}); continue; }
    const old=state.jokers?.[id];
    // A joker already on the table keeps its letter, unless the real letter came out of the hand (the swap).
    if(before.has(id) && old && letter!==old && !played.some(p=>!tileOf(p).joker && tileOf(p).letter===old))
      throw Error('A joker on the table keeps its letter');
    jokers[id]=letter;
  }
  for(const word of board)
    if(word.tiles.length<state.settings.minWordLength)errors.push({code:'short',word:wordText(word.tiles,{...jokers})});
  // A word is one colour: its letters all share it (a joker takes the word's colour).
  for(const word of board) {
    const used=new Set(word.tiles.map(id=>colorOf(id,state.colors)).filter(c=>c!=null));
    if(used.size>1)errors.push({code:'colors',word:wordText(word.tiles,{...jokers})});
  }

  const oldWords=new Set(state.board.map(w=>w.tiles.join(',')));
  const points=played.reduce((s,id)=>s+tileValue(id,jokers),0);
  if(!state.opened) {
    // Before the opening, the words on the table stay as they are; the turn only adds new words of the hand's tiles.
    const now=new Set(board.map(w=>w.tiles.join(',')));
    if([...oldWords].some(key=>!now.has(key)))errors.push({code:'locked'});
    if(played.length && points<state.settings.openingPoints)
      errors.push({code:'opening',points,needed:state.settings.openingPoints});
  }
  const changed=board.filter(w=>!oldWords.has(w.tiles.join(',')));
  // The dictionary checks the words this turn made or changed; the others were checked when they were placed. A
  // word the table voted in during this game counts too. Too-short words and unchosen jokers are reported above.
  if(state.isWord) {
    const unknown=changed.filter(w=>w.tiles.length>=state.settings.minWordLength &&
      w.tiles.every(id=>!tileOf(id).joker || jokers[id]))
      .filter(w=>{ const k=wordKey(w.tiles,jokers); return !state.isWord(k) && !(state.accepted ?? []).includes(k); });
    if(unknown.length)errors.push({code:'unknown',words:unknown.map(w=>({key:wordKey(w.tiles,jokers),
      text:wordText(w.tiles,jokers)}))});
  }
  const words=changed.map(w=>wordText(w.tiles,jokers));
  return {errors,board,jokers,played,points,words,hand:state.hand.filter(id=>!placed.has(id))};
}

// The next seat to play after `seat`, skipping those who left. Null when nobody else is in.
export function nextSeat(seats,seat) {
  for(let step=1;step<=seats.length;step++) {
    const i=(seat+step)%seats.length;
    if(!seats[i].left)return i;
  }
  return null;
}

// The end, as in the original: everyone loses what is left in hand, and the winner collects the others' total.
// `winner` null means the pool ran out and a full round passed: the lowest hand wins (the earliest seat on a tie).
// A seat that left scores nothing and cannot win.
export function finalScores(seats,values,winner) {
  if(winner==null) {
    let best=null;
    seats.forEach((s,i)=>{ if(!s.left && (best==null || values[i]<values[best]))best=i; });
    winner=best;
  }
  const others=values.reduce((sum,v,i)=>i===winner || seats[i].left ? sum : sum+v,0);
  const scores=values.map((v,i)=>seats[i].left ? 0 : i===winner ? others-v : -v);
  return {winner,scores};
}

// "בקשו מהשולחן לאשר": the words a player asks the table to accept, as keys. Up to three, each a plain key the
// dictionary does not know and the table has not voted in yet.
export function readAsked(words,isWord,accepted=[]) {
  if(!Array.isArray(words) || !words.length || words.length>tableRules.maxAsked)throw Error('Invalid words');
  const seen=new Set();
  return words.map(w=>{
    const key=typeof w?.key==='string' ? w.key : '';
    const text=typeof w?.text==='string' ? w.text : key;
    if(!/^[א-ת]{3,15}$/.test(key) || /[ךםןףץ]/.test(key) || seen.has(key))throw Error('Invalid words');
    if(isWord(key) || accepted.includes(key))throw Error('Already a word');
    if(!/^[א-ת]{3,15}$/.test(text))throw Error('Invalid words');
    seen.add(key);
    return {key,text};
  });
}

// A vote's result: a word passes with a majority of everyone who may vote, not only of those who did. Silence, a
// tie or an absent player count as "no". `votes` maps a seat to the keys it accepted.
export function tally(vote,eligible) {
  const accepted=[], rejected=[];
  for(const word of vote.words) {
    const yes=eligible.filter(seat=>(vote.votes?.[String(seat)] ?? []).includes(word.key)).length;
    (yes*2>eligible.length ? accepted : rejected).push(word);
  }
  return {accepted,rejected};
}

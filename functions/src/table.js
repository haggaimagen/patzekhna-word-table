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
  rackSizes:[12,14,16,18,21],rackSize:14,turnSecondsOptions:[30,60,90,120],turnSeconds:60,
  colorOptions:[1,2,3,4],colors:1,colorChance:0.5,
  lobbyMs:30*60_000,startDelayMs:3_000,graceMs:2_500,maxMissed:3,maxWords:60,maxWordTiles:24,logSize:30,
  voteMs:15_000,maxAsked:3};

export function tableSettings(input={},tuning=tableTuning(null)) {
  const rackSize=tableRules.rackSizes.includes(input.rackSize) ? input.rackSize : tableRules.rackSize;
  const turnSeconds=tableRules.turnSecondsOptions.includes(input.turnSeconds) ? input.turnSeconds : tableRules.turnSeconds;
  const colors=tableRules.colorOptions.includes(input.colors) ? input.colors : tableRules.colors;
  const stake=tuning.options.includes(input.stake) ? input.stake : tuning.options[0];
  return {rackSize,turnSeconds,colors,stake,minWordLength:tableRules.minWordLength,openingPoints:tableRules.openingPoints,
    timeoutPenalty:tableRules.timeoutPenalty};
}

// The price of a seat (README.md, "Diamonds"): the game's settings (`gameTuning/{env}`, key `wordTable`, edited in
// StageAdmin's Games tab) list the prices a host may pick and whether a free table is one of them; every player pays
// the table's price when the game starts, and the winner takes the pot less the house's cut. Anything invalid falls
// back to the defaults as a whole, as the apps do; with the diamonds switched off (`economy.enabled: false`) every
// table is free.
export const stakeRules={stakes:[20,50,100],freePlay:true,houseCut:10,maxStakes:5,maxStake:1000,botPrice:10,
  // A priced table with bots where a bot finishes first: the whole pot goes to the house (the user, 2026-11-16).
  // 'bestHuman' would give it, less the cut, to the human with the lowest hand still at the table; 'refund' would give
  // each human still in their price back.
  botWin:'house'};

export function tableTuning(payload) {
  if(payload?.economy?.enabled===false)return {stakes:[],freePlay:true,houseCut:0,botPrice:0,options:[0]};
  const raw=payload?.wordTable;
  let tuning={stakes:stakeRules.stakes,freePlay:stakeRules.freePlay,houseCut:stakeRules.houseCut};
  let botPrice=stakeRules.botPrice;
  if(raw && typeof raw==='object') {
    const stakes=raw.stakes ?? tuning.stakes, freePlay=raw.freePlay ?? tuning.freePlay, houseCut=raw.houseCut ?? tuning.houseCut;
    const valid=Array.isArray(stakes) && stakes.length<=stakeRules.maxStakes
      && stakes.every((n,i)=>Number.isInteger(n) && n>=1 && n<=stakeRules.maxStake && (i===0 || n>stakes[i-1]))
      && typeof freePlay==='boolean' && Number.isInteger(houseCut) && houseCut>=0 && houseCut<=100
      && (freePlay || stakes.length>0);
    if(valid)tuning={stakes,freePlay,houseCut};
    // The price of a game against bots only stands apart: a bad value keeps its own default, not the prices'.
    const bot=raw.botPrice ?? botPrice;
    if(Number.isInteger(bot) && bot>=0 && bot<=stakeRules.maxStake)botPrice=bot;
  }
  return {...tuning,botPrice,options:[...(tuning.freePlay ? [0] : []),...tuning.stakes]};
}

// The price a host gets: the one they asked for if their diamonds cover it, otherwise the dearest they can pay up to
// it, otherwise the cheapest they can pay at all; null when they cannot pay any (no free tables, too few diamonds).
// An app from before prices sends no balance and can only open a free table.
export function chooseStake(tuning,wanted,balance) {
  const can=tuning.options.filter(n=>n===0 || (Number.isFinite(balance) && n<=balance));
  if(!can.length)return null;
  if(can.includes(wanted))return wanted;
  const below=can.filter(n=>n<=wanted);
  return below.length ? below[below.length-1] : can[0];
}

// What each seat gets back when the game ends. Bots never pay and never collect (README.md, "Bots"), so the pot is
// the price × the human seats, every one of which paid at the start (a leaver too). The winner takes it less the house's
// cut (rounded in the house's favour). When a bot wins, the house keeps the whole pot (`stakeRules.botWin`). A game
// with no winner gives each human still at the table their own price back, with no cut. A game against bots only
// (`botTable`) has no pot: its price was the cost of the game.
export function payouts(seats,stake,houseCut,winner,{values=[],botTable=false,botWin=stakeRules.botWin}={}) {
  const none=seats.map(()=>0);
  if(!stake || botTable)return {pot:0,cut:0,taker:null,payouts:none};
  const humans=seats.map((s,i)=>i).filter(i=>!seats[i].bot);
  const pot=stake*humans.length;
  let taker=winner;
  if(taker!=null && seats[taker]?.bot) {
    taker=null;
    if(botWin==='house')return {pot,cut:pot,taker:null,payouts:none};
    if(botWin==='bestHuman')for(const i of humans)
      if(!seats[i].left && (taker==null || (values[i] ?? 0)<(values[taker] ?? 0)))taker=i;
  }
  if(taker==null)return {pot,cut:0,taker:null,payouts:seats.map(s=>!s.bot && !s.left ? stake : 0)};
  const cut=Math.ceil(pot*houseCut/100);
  return {pot,cut,taker,payouts:none.map((n,i)=>i===taker ? pot-cut : 0)};
}

// The host removes a player from the lobby (README.md, "Removing a player"): their seat and hand id go, and their id
// joins `kicked`, so the table's code refuses them from then on. Null when there is no such human seat (a bot is
// removed with `removeBot`; the host cannot remove themselves).
export function kickSeat(seats,handIds,kicked,id,host) {
  if(id===host)return null;
  const index=seats.findIndex(s=>!s.bot && s.id===id);
  if(index<0)return null;
  return {seats:seats.filter((s,i)=>i!==index),handIds:handIds.filter((h,i)=>i!==index),kicked:[...new Set([...(kicked ?? []),id])]};
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
// A seat that left (or was dropped) cannot win, and pays its hand like any loser: leaving is a forfeit, not a way out.
export function finalScores(seats,values,winner) {
  if(winner==null) {
    let best=null;
    seats.forEach((s,i)=>{ if(!s.left && (best==null || values[i]<values[best]))best=i; });
    winner=best;
  }
  const others=values.reduce((sum,v,i)=>i===winner ? sum : sum+v,0);
  const scores=values.map((v,i)=>i===winner ? others-v : -v);
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

// Bot players (README.md, "Bots"): the host can seat up to three bots in the lobby, each at a level from 1 to 5. A bot
// plays on the server, so a phone that sleeps never stops it: when its turn comes, the table carries `turn.botAt`, and
// the phones at the table call `timeout` from then on (the same call that ends a sleeping player's turn), which plays
// the bot's move in two steps. Shortly into the turn the bot finds its move and saves it as its draft, with a window
// (`from`–`until`) in which the phones show its letters arriving one at a time, as a player places them; when its
// time is up (`botThink`) the move is played.
//
// The move finder works over the same dictionary as the rules. It knows two kinds of move:
//   - a new word from the hand's letters (one colour, jokers filling in for missing letters);
//   - letters from the hand added to a word on the board (a word may be rearranged, as a player may).
// It does not cut words in two or move letters between words. The levels differ in how much of a turn they play and
// how long they take: level 5 plays everything it finds, best first, in half the turn's clock; level 1 plays one
// short word in about 70% of it. Every level makes the first-turn minimum when its letters allow.
import {ALPHABET,LETTER_VALUES,tileOf,colorOf} from './table.js';
import {commonKeys} from './dictionary.js';

export const botRules={
  levels:[1,2,3,4,5],
  level:3,
  /** The share of the turn's clock each level takes, level 1 first; each turn varies it by up to ±`jitter`. */
  think:[0.70,0.65,0.60,0.55,0.50],
  jitter:0.04,
  /** When a bot finds its move: this long into its turn. */
  lookMs:1_500,
  /** How long each letter takes to arrive on the board, level 1 first. */
  letterMs:[1_500,1_200,1_000,800,600],
  /** The finished board stands this long before the move is played. */
  settleMs:1_200,
  /** How many moves (a word, or letters added to one) each level makes in a turn, level 1 first. */
  actions:[1,1,2,3,30],
  /** The most letters each level plays in a turn, level 1 first (the opening may take more to make the minimum). */
  letters:[3,5,8,11,106],
  /** The longest word each level makes or leaves on the board after adding to it, level 1 first (the user, 2026-11-16).
   *  Only an opening its letters cannot make otherwise lifts it, for that turn: the shortest words that make it. */
  wordLength:[4,5,5,6,7],
  /** The common words each level picks from, level 1 first: the N most frequent (dictionary.js, `commonKeys`), plus
   *  the hand-added allow list; 0 is all of them. Bots never play the rare forms the full list also allows. */
  pool:[4_000,6_000,10_000,16_000,0],
  /** The greediest level's look-ahead: the best first moves of each length it follows through, and at most in all. */
  lookahead:2,
  lookaheadMax:16,
  /** First words an opening tries when the dearest one strands the letters. */
  openers:24,
  /** The most letters a bot adds to one word on the board, by level. */
  extra:[1,2,2,3,3],
  names:['ביפ','בופ','צ׳יפ','זיגי','פיקסל','נאנו','ביטי','רובי'],
};

export const validLevel=level=>botRules.levels.includes(level);

/** A bot's name at a table: the first one not taken yet. */
export function botName(seats,random=Math.random) {
  const taken=new Set(seats.map(s=>s.nickname));
  const free=botRules.names.filter(n=>!taken.has(n));
  if(!free.length)return `בוט ${seats.length+1}`;
  return free[Math.floor(random()*free.length)];
}

/** How long a bot takes over a turn: its level's share of the clock, varied a little each turn. */
export function thinkMs(level,turnSeconds,random=Math.random) {
  const share=botRules.think[(validLevel(level) ? level : botRules.level)-1]+(random()*2-1)*botRules.jitter;
  return Math.round(turnSeconds*1000*share);
}

// A level's words by their letters: a key's letters sorted ("signature") → the keys spelled with exactly those
// letters. Hebrew letters sort in alphabet order by code point, and the keys have no final forms. Built once per level
// per instance.
const indexes=new Map();
export function dictionaryIndex(level=5) {
  const size=botRules.pool[(validLevel(level) ? level : 5)-1];
  const hit=indexes.get(size);
  if(hit)return hit;
  const {ranked,allow}=commonKeys();
  const keys=new Set([...(size ? ranked.slice(0,size) : ranked),...allow]);
  const bySig=new Map();
  for(const key of keys) {
    const sig=[...key].sort().join('');
    const list=bySig.get(sig);
    if(list)list.push(key); else bySig.set(sig,[key]);
  }
  const index={keys,bySig,sigs:[...bySig.keys()]};
  indexes.set(size,index);
  return index;
}

const sigOf=letters=>[...letters].sort().join('');
const valueOf=letters=>[...letters].reduce((s,l)=>s+(LETTER_VALUES[l] ?? 0),0);
const letterOf=(id,jokers)=>{ const t=tileOf(id); return t.joker ? jokers[id] : t.letter; };

// The hand by colour and letter: {colors: Map(colour → Map(letter → [tile ids])), jokers: [tile ids]}.
function sortHand(hand,colors) {
  const byColor=new Map(), jokers=[];
  for(const id of hand) {
    const tile=tileOf(id);
    if(tile.joker) { jokers.push(id); continue; }
    const c=colorOf(id,colors);
    if(!byColor.has(c))byColor.set(c,new Map());
    const letters=byColor.get(c);
    if(!letters.has(tile.letter))letters.set(tile.letter,[]);
    letters.get(tile.letter).push(id);
  }
  return {byColor,jokers};
}

// How many jokers a signature needs from the letters of one colour: Infinity when more than the hand has.
function shortfall(sig,letters,jokers) {
  let missing=0;
  for(let i=0;i<sig.length;) {
    let j=i;
    while(j<sig.length && sig[j]===sig[i])j++;
    const have=letters?.get(sig[i])?.length ?? 0;
    if(j-i>have) { missing+=j-i-have; if(missing>jokers)return Infinity; }
    i=j;
  }
  return missing;
}

// Every new word the hand can spell, one colour each: [{kind:'word', sig, color, jokers, tiles, value}].
function handWords(idx,sorted,size,accepts) {
  const found=[];
  const jokers=sorted.jokers.length;
  const colors=sorted.byColor.size ? [...sorted.byColor.keys()] : [0];
  for(const sig of idx.sigs) {
    if(sig.length>size)continue;
    for(const c of colors) {
      const need=shortfall(sig,sorted.byColor.get(c),jokers);
      if(need===Infinity || need>=sig.length)continue;
      const key=idx.bySig.get(sig).find(accepts);
      if(key)found.push({kind:'word',sig,key,color:c,jokers:need,tiles:sig.length,value:valueOf(sig)});
    }
  }
  return found;
}

// Multisets of up to `max` letters from one colour's letters: arrays of letters.
function extrasOf(letters,max) {
  const pool=[...(letters ?? new Map()).entries()].map(([l,ids])=>[l,ids.length]);
  const out=[];
  const walk=(from,picked)=>{
    if(picked.length)out.push([...picked]);
    if(picked.length===max)return;
    for(let i=from;i<pool.length;i++) {
      const [l,n]=pool[i];
      if(picked.filter(x=>x===l).length>=n)continue;
      picked.push(l); walk(i,picked); picked.pop();
    }
  };
  walk(0,[]);
  return out;
}

// Letters from the hand added to a word on the board (the word may be rearranged): [{kind:'extend', word, key, color,
// letters (from the hand), jokerLetters, tiles, value}]. At most one joker goes into an added group.
function extensions(idx,board,boardJokers,colors,sorted,max,accepts) {
  const found=[];
  for(const word of board) {
    const letters=word.tiles.map(id=>letterOf(id,boardJokers));
    if(letters.some(l=>!l))continue;
    const own=word.tiles.map(id=>colorOf(id,colors)).find(c=>c!=null);
    const choices=own==null ? [...sorted.byColor.keys()] : [own];
    if(own==null && !choices.length && sorted.jokers.length)choices.push(0);
    const seen=new Set();
    for(const c of choices) {
      const extras=extrasOf(sorted.byColor.get(c),max).map(real=>({real,joker:null}));
      if(sorted.jokers.length) {
        for(const real of [[],...extrasOf(sorted.byColor.get(c),max-1)])
          for(const l of ALPHABET)extras.push({real,joker:l});
      }
      for(const extra of extras) {
        const added=extra.joker ? [...extra.real,extra.joker] : extra.real;
        const sig=sigOf([...letters,...added]);
        const id=`${c}|${sig}`;
        if(seen.has(id))continue;
        seen.add(id);
        const key=idx.bySig.get(sig)?.find(accepts);
        if(!key)continue;
        found.push({kind:'extend',word:word.id,key,color:c,letters:extra.real,jokerLetter:extra.joker,
          jokers:extra.joker ? 1 : 0,tiles:added.length,length:letters.length+added.length,value:valueOf(added)});
      }
    }
  }
  return found;
}

const moveID=m=>`${m.kind}|${m.key}|${m.color}|${m.word ?? ''}|${m.letters?.join('') ?? ''}|${m.jokerLetter ?? ''}`;

// Better first: more letters out of the hand, then more points, then fewer jokers spent.
const better=(a,b)=>b.tiles-a.tiles || b.value-a.value || a.jokers-b.jokers;

/**
 * A bot's move for its turn, or null when it has none (it then draws a letter).
 * `state` is what `checkPlay` takes: the board, the jokers, the colours, the bot's hand, whether it opened, the
 * settings, `isWord` (with StageAdmin's lists) and the words the table voted in. Returns `{board, jokers}`, a
 * proposal for `checkPlay`.
 */
export function findMove(state,level,options={}) {
  const move=planMove(state,level,options);
  if(move || state.opened || options.idx)return move;
  // An opening the level's own words cannot make: every common word, before drawing (rare forms still never).
  return planMove(state,level,{...options,idx:dictionaryIndex(5)});
}

function planMove(state,level,{random=Math.random,idx=null,first=null,found=null,cap=null}={}) {
  level=validLevel(level) ? level : botRules.level;
  idx ??= dictionaryIndex(level);
  cap ??= botRules.wordLength[level-1];
  // A word's length once played: a new word's letters, or the board word's with the letters added.
  const short=m=>(m.length ?? m.tiles)<=cap;
  // The greediest level looks ahead: it tries its best first moves of each length (a long word can strand letters a
  // shorter one would not), each followed through, and keeps the turn that plays the most letters, then points.
  if(level===5 && first==null) {
    const accepts=key=>(state.isWord ? state.isWord(key) : idx.keys.has(key)) || (state.accepted ?? []).includes(key);
    const sorted=sortHand(state.hand,state.colors ?? {});
    const words=handWords(idx,sorted,state.hand.length,accepts).filter(short);
    const firsts=[...words,...(state.opened ? extensions(idx,state.board,state.jokers,state.colors ?? {},sorted,
      botRules.extra[4],accepts).filter(short) : [])].sort(better);
    const perLength=new Map();
    const tries=firsts.filter(m=>{ const n=perLength.get(m.tiles) ?? 0; perLength.set(m.tiles,n+1); return n<botRules.lookahead; })
      .slice(0,botRules.lookaheadMax);
    let best=null, bestScore=null;
    for(const move0 of tries) {
      const move=planMove(state,5,{random,idx,first:moveID(move0),found:words,cap});
      if(!move)continue;
      const before=new Set(state.board.flatMap(w=>w.tiles));
      const played=move.board.flatMap(w=>w.tiles).filter(id=>!before.has(id));
      const score=[played.length,valueOf(played.map(id=>tileOf(id).joker ? move.jokers[id] : tileOf(id).letter).join(''))];
      if(!best || score[0]>bestScore[0] || (score[0]===bestScore[0] && score[1]>bestScore[1])) { best=move; bestScore=score; }
    }
    // An opening the capped words cannot make: the lower levels' way, without the cap.
    if(!best && !state.opened && cap<15)return planMove(state,2,{random,idx,cap:15});
    return best;
  }
  const accepts=key=>(state.isWord ? state.isWord(key) : idx.keys.has(key)) || (state.accepted ?? []).includes(key);
  const colors=state.colors ?? {};
  let hand=[...state.hand];
  const board=state.board.map(w=>({id:w.id,tiles:[...w.tiles]}));
  const jokers={...state.jokers};
  const ids=new Set(board.map(w=>w.id));
  let made=0;
  const newID=()=>{ let id; do { id=`b${state.turn ?? 0}x${made++}`; } while(ids.has(id)); ids.add(id); return id; };

  // Takes one tile of a letter and colour out of the hand, or a joker standing for it.
  const take=(sorted,letter,color,forceJoker=false)=>{
    const list=forceJoker ? null : sorted.byColor.get(color)?.get(letter);
    const id=list?.length ? list.shift() : sorted.jokers.shift();
    if(tileOf(id).joker)jokers[id]=letter;
    hand=hand.filter(h=>h!==id);
    return id;
  };
  const apply=move=>{
    const sorted=sortHand(hand,colors);
    if(move.kind==='word') {
      board.push({id:newID(),tiles:[...move.key].map(l=>take(sorted,l,move.color))});
      return;
    }
    const word=board.find(w=>w.id===move.word);
    // The new spelling, letter by letter: the word's own tiles first, then the added ones.
    const pool=word.tiles.map(id=>({id,letter:letterOf(id,jokers)}));
    for(const l of move.letters)pool.push({id:take(sorted,l,move.color),letter:l});
    if(move.jokerLetter)pool.push({id:take(sorted,move.jokerLetter,move.color,true),letter:move.jokerLetter});
    word.tiles=[...move.key].map(l=>{ const i=pool.findIndex(p=>p.letter===l); return pool.splice(i,1)[0].id; });
  };
  const fits=(move,sorted)=>move.kind!=='word' || shortfall(move.sig,sorted.byColor.get(move.color),sorted.jokers.length)<=move.jokers;

  // The hand's words, found once; after each move only those still spelled by what is left are kept.
  let words=(found ?? handWords(idx,sortHand(hand,colors),hand.length,accepts)).filter(short);
  const step=(pick,{extend=state.opened,max=botRules.extra[level-1],limit=true}={})=>{
    const sorted=sortHand(hand,colors);
    words=words.filter(m=>m.tiles<=hand.length && fits(m,sorted));
    let moves=[...words,...(extend ? extensions(idx,board,jokers,colors,sorted,max,accepts).filter(short) : [])];
    // Within the level's letters for the turn; the turn's first move may be the smallest there is instead.
    const left=botRules.letters[level-1]-(state.hand.length-hand.length);
    const within=limit ? moves.filter(m=>m.tiles<=left) : moves;
    if(within.length)moves=within;
    else if(hand.length<state.hand.length || !moves.length)return null;
    else { const least=Math.min(...moves.map(m=>m.tiles)); moves=moves.filter(m=>m.tiles===least); }
    // The look-ahead's first move: the k-th best.
    const move=first!=null && hand.length===state.hand.length ? moves.find(m=>moveID(m)===first) : pick(moves);
    if(!move)return null;
    apply(move);
    return move;
  };
  const best=moves=>moves.sort(better)[0];
  const among=n=>moves=>{ const top=moves.sort(better).slice(0,n); return top[Math.floor(random()*top.length)]; };
  // Level 2: one of its three best words (up to five letters, as `letters` says). Level 1: the shortest word it has. Both add letters to
  // a word on the board only when they have no word of their own.
  const ownFirst=moves=>{ const own=moves.filter(m=>m.kind==='word'); return own.length ? own : moves; };
  const middling=moves=>{
    const list=ownFirst(moves);
    return among(3)(list);
  };
  const shortest=moves=>{
    const list=ownFirst(moves).sort((a,b)=>a.tiles-b.tiles || a.jokers-b.jokers || a.value-b.value);
    const least=list.filter(m=>m.tiles===list[0].tiles);
    return least[Math.floor(random()*least.length)];
  };
  const pick=[shortest,middling,among(3),among(2),best][level-1];
  const proposal=()=>{
    const onBoard=new Set(board.flatMap(w=>w.tiles));
    return {board,jokers:Object.fromEntries(Object.entries(jokers).filter(([id])=>onBoard.has(id)))};
  };

  if(!state.opened) {
    // The opening: new words only, worth the minimum together. The lower levels look for the least that makes it.
    const needed=state.settings.openingPoints;
    const start=hand.length;
    let points=0;
    if(level<=2) {
      const sorted=sortHand(hand,colors);
      const one=words.filter(m=>m.value>=needed && fits(m,sorted)).sort((a,b)=>a.tiles-b.tiles || a.value-b.value);
      if(one.length) {
        apply(one[Math.floor(random()*Math.min(level===1 ? 1 : 3,one.length))]);
        return proposal();
      }
      // No single word makes it: the dearest words until it is made, trying other first words when the dearest
      // strands the letters. Still short with the level's longest words: the cap is lifted for this opening, so the
      // bot opens with the shortest words that make it rather than never.
      const openers=words.filter(m=>fits(m,sorted)).sort((a,b)=>b.value-a.value || a.tiles-b.tiles);
      while(points<needed) {
        const move=step(moves=>moves.sort((a,b)=>b.value-a.value || a.tiles-b.tiles)[0],{extend:false,limit:false});
        if(!move) {
          if(first!=null)return null;
          for(const opener of openers.slice(1,botRules.openers)) {
            const tried=planMove(state,level,{random,idx,cap,first:moveID(opener),found:openers});
            if(tried)return tried;
          }
          return cap<15 ? planMove(state,level,{random,idx,cap:15}) : null;
        }
        points+=move.value;
      }
      return proposal();
    }
    for(let n=0;n<botRules.actions[level-1];n++) {
      const move=step(pick,{extend:false});
      if(!move)break;
      points+=move.value;
      if(!hand.length)break;
    }
    if(points>=needed)return proposal();
    // Not enough: start again from the hand and take the dearest words instead.
    if(hand.length!==start || cap<15)return planMove(state,2,{random,idx,cap:hand.length!==start ? cap : 15});
    return null;
  }

  for(let n=0;n<botRules.actions[level-1] && hand.length;n++) {
    if(!step(pick))break;
  }
  return hand.length<state.hand.length ? proposal() : null;
}

// The letters' window: each arrives `letterMs` after the last, ending `settleMs` before the move is played, at
// `botThink` or later when the letters need longer, and always before the clock runs out.
export function botReveal(level,letters,now,think,endsAt) {
  const pace=botRules.letterMs[(level ?? 3)-1] ?? 1_000;
  const latest=endsAt-1_500;
  const commitAt=Math.max(now+botRules.settleMs+600,Math.min(latest,Math.max(think,now+300+letters*pace+botRules.settleMs)));
  const until=commitAt-botRules.settleMs;
  const from=Math.max(now+300,until-letters*pace);
  return {from:Math.min(from,until),until,commitAt};
}

/** A table of the host and bots only: its price is StageAdmin's flat `botPrice`, and it has no pot. */
export const isBotTable=seats=>seats.some(s=>s.bot) && seats.filter(s=>!s.bot).length===1;

/** A bot's seat, always ready. Its id never looks like a player's (a 64-character hash). */
export function botSeat(seats,level,now,id) {
  return {id,nickname:botName(seats),platform:'bot',appVersion:'',joinedMs:now,bot:true,level,
    count:0,opened:false,ready:true,left:false,away:false,missed:0,score:null,value:null};
}

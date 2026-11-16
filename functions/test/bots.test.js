// Bot players (src/bots.js, README.md "Bots"): the move finder, the levels, and what bots do to the diamonds.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TILES,tableSettings,tableTuning,payouts,deal,paint,checkPlay,tileOf,colorOf,wordKey} from '../src/table.js';
import {isWord,commonKeys} from '../src/dictionary.js';
import {botRules,findMove,thinkMs,botName,isBotTable,botSeat,validLevel,botReveal,dictionaryIndex} from '../src/bots.js';

const settings=tableSettings({});
const spell=(word,used=new Set())=>[...word].map(l=>{
  const base={'ך':'כ','ם':'מ','ן':'נ','ף':'פ','ץ':'צ'}[l] ?? l;
  const id=TILES.find(t=>t.letter===base && !used.has(t.id)).id;
  used.add(id);
  return id;
});
const JOKER=TILES.find(t=>t.joker).id;
const seeded=seed=>()=>{ seed=(seed*16807)%2147483647; return seed/2147483647; };
const state=(over={})=>({board:[],jokers:{},colors:{},hand:[],opened:false,settings,isWord,accepted:[],turn:1,...over});
const play=(s,level,random=seeded(7))=>{
  const move=findMove(s,level,{random});
  return move && checkPlay(s,move);
};

test('bots: a move the rules accept, at every level', ()=>{
  for(let level=1;level<=5;level++) {
    const used=new Set();
    const hand=[...spell('שלומ',used),...spell('ספר',used),...spell('בית',used),...spell('אהו',used)];
    const r=play(state({hand}),level);
    assert.ok(r,`level ${level} found a move`);
    assert.deepEqual(r.errors,[],`level ${level}`);
    assert.ok(r.points>=settings.openingPoints,'the opening is worth the minimum');
  }
});

test('bots: every level makes the first-turn minimum when one word is not enough', ()=>{
  // Each 3-letter word here is worth less than 10; only two or more together make the opening.
  const used=new Set();
  const hand=[...spell('אבא',used),...spell('אמה',used),...spell('ילד',used),...spell('ורד',used)];
  for(let level=1;level<=5;level++) {
    const r=play(state({hand}),level);
    assert.ok(r,`level ${level}`);
    assert.deepEqual(r.errors,[]);
    assert.ok(r.points>=10,`level ${level}: ${r.points} points`);
  }
});

test('bots: no move when the letters cannot make the opening; a draw instead', ()=>{
  const hand=spell('אאו');
  for(let level=1;level<=5;level++)assert.equal(findMove(state({hand}),level),null);
});

test('bots: before the opening the board stays as it is', ()=>{
  const used=new Set();
  const board=[{id:'w1',tiles:spell('ספר',used)}];
  const hand=[...spell('ים',used),...spell('שלומ',used),...spell('בית',used),...spell('צדק',used)];
  for(let level=1;level<=5;level++) {
    const r=play(state({board,hand}),level);
    assert.deepEqual(r.errors,[]);
    assert.deepEqual(r.board.find(w=>w.id==='w1').tiles,board[0].tiles,`level ${level}`);
  }
});

test('bots: after the opening a letter goes into a word on the board', ()=>{
  const used=new Set();
  const board=[{id:'w1',tiles:spell('ספר',used)}];
  const hand=spell('ים',used);                    // ספרים, nothing of their own to spell
  for(let level=2;level<=5;level++) {
    const r=play(state({board,hand,opened:true}),level);
    assert.ok(r,`level ${level}`);
    assert.deepEqual(r.errors,[]);
    assert.ok(r.played.length>=1);
    assert.equal(r.board.length,1,'the same word, longer');
  }
});

test('bots: jokers stand in for missing letters and keep a letter', ()=>{
  const used=new Set();
  const hand=[...spell('שלו',used),JOKER,...spell('ספר',used),...spell('חתול',used)];
  const r=play(state({hand}),5);
  assert.deepEqual(r.errors,[]);
  for(const w of r.board)for(const id of w.tiles)if(tileOf(id).joker)assert.ok(r.jokers[id]);
});

test('bots: one colour per word', ()=>{
  const random=seeded(11);
  const {hands}=deal(4,14,random);
  const colors=paint(4,random);
  for(let level=1;level<=5;level++) {
    const s=state({hand:hands[level % 4],colors});
    const move=findMove(s,level,{random});
    if(!move)continue;
    for(const w of move.board) {
      const used=new Set(w.tiles.map(id=>colorOf(id,colors)).filter(c=>c!=null));
      assert.ok(used.size<=1,`level ${level}`);
    }
    assert.deepEqual(checkPlay(s,move).errors,[]);
  }
});

test('bots: a word StageAdmin denied is never played', ()=>{
  const used=new Set();
  const hand=[...spell('שלומ',used),...spell('ספר',used)];
  const deny=new Set(['שלומ','ספר','לומ','ספרו']);
  const r=play(state({hand,isWord:k=>!deny.has(k) && isWord(k)}),5);
  if(r) {
    assert.deepEqual(r.errors,[]);
    assert.ok(!r.words.some(w=>deny.has(w)));
  }
});

// One turn from many random hands, opened, on a board another bot opened: each level plays more than the one below,
// level 1 about one short word.
test('bots: each level plays more in a turn than the one below; level 1 about one word', ()=>{
  const letters=[0,0,0,0,0], words=[0,0,0,0,0];
  const runs=20;
  for(let seed=1;seed<=runs;seed++) {
    const random=seeded(seed*7919);
    const {hands}=deal(2,14,random);
    const other=state({hand:hands[1]});
    const opening=findMove(other,3,{random});
    const board=opening ? checkPlay(other,opening).board : [];
    for(let level=1;level<=5;level++) {
      const s=state({board,jokers:opening?.jokers ?? {},hand:hands[0],opened:true,turn:2});
      const move=findMove(s,level,{random});
      if(!move)continue;
      const r=checkPlay(s,move);
      assert.deepEqual(r.errors,[],`level ${level}, seed ${seed}`);
      assert.ok(r.played.length<=botRules.letters[level-1] || r.board.length-board.length<=1);
      letters[level-1]+=r.played.length/runs;
      words[level-1]+=r.words.length/runs;
    }
  }
  for(let i=1;i<5;i++)assert.ok(letters[i]>letters[i-1],`letters a turn by level: ${letters.map(n=>n.toFixed(1))}`);
  assert.ok(words[0]<=1.05,'level 1: one word');
  assert.ok(letters[0]<=3.5,'level 1: a short one');
});

test('bots: each level keeps to its longest word, 4 letters at level 1 up to 7 at level 5', ()=>{
  for(let seed=1;seed<=12;seed++) {
    const random=seeded(seed*104729);
    const {hands}=deal(2,21,random);
    const other=state({hand:hands[1]});
    const opening=findMove(other,2,{random});
    const board=opening ? checkPlay(other,opening).board : [];
    const before=new Map(board.map(w=>[w.id,w.tiles.join()]));
    for(let level=1;level<=5;level++) {
      const s=state({board,jokers:opening?.jokers ?? {},hand:hands[0],opened:true,turn:2});
      const move=findMove(s,level,{random});
      if(!move)continue;
      assert.deepEqual(checkPlay(s,move).errors,[]);
      for(const w of move.board.filter(w=>before.get(w.id)!==w.tiles.join()))
        assert.ok(w.tiles.length<=botRules.wordLength[level-1],`level ${level}: a word of ${w.tiles.length}`);
    }
  }
});

test('bots: an opening the level\'s longest words cannot make lifts the cap for that turn', ()=>{
  // A cap no word meets (2 letters) stands for letters whose words within the cap are worth too little.
  const used=new Set();
  const hand=[...spell('שלומ',used),...spell('ספר',used)];
  for(const level of [1,3,5]) {
    const move=findMove(state({hand}),level,{random:seeded(3),cap:2});
    assert.ok(move,`level ${level} opens`);
    const r=checkPlay(state({hand}),move);
    assert.deepEqual(r.errors,[]);
    assert.ok(r.points>=10,`level ${level}: ${r.points} points`);
  }
});

test('bots: only common words — a legal but rare form like הצטערכן never', ()=>{
  const {ranked,allow}=commonKeys();
  assert.ok(ranked.length>20_000,`${ranked.length} common keys`);
  assert.ok(isWord('הצטערכנ'),'legal for the players');
  assert.ok(!dictionaryIndex(5).keys.has('הצטערכנ'),'never a bot\'s');
  for(let level=1;level<=5;level++)
    assert.equal(dictionaryIndex(level).keys.size,(botRules.pool[level-1] || ranked.length)+allow.length,`level ${level}'s pool`);
  const common=new Set([...ranked,...allow]);
  const pool=level=>dictionaryIndex(level).keys;
  for(let seed=1;seed<=15;seed++) {
    const random=seeded(seed*31337);
    const {hands}=deal(2,14,random);
    const other=state({hand:hands[1]});
    const opening=findMove(other,3,{random});
    const board=opening ? checkPlay(other,opening).board : [];
    for(let level=1;level<=5;level++) {
      const s=state({board,jokers:opening?.jokers ?? {},hand:hands[0],opened:true,turn:2});
      const move=findMove(s,level,{random});
      if(!move)continue;
      const r=checkPlay(s,move);
      assert.deepEqual(r.errors,[]);
      for(const w of r.board.filter(w=>!board.some(b=>b.id===w.id && b.tiles.join()===w.tiles.join()))) {
        const key=wordKey(w.tiles,r.jokers);
        assert.ok(pool(level).has(key),`level ${level} played ${key}, outside its pool`);
        assert.ok(common.has(key));
      }
    }
  }
});

// How often each level finds a play with its pool: the opening, and a turn after it on a board, over sample racks at
// the default settings and at hard ones (fewer letters, more colours). The numbers are printed with the test.
test('bots: every level finds plays with its common words', t=>{
  const runs=40;
  for(const [rack,colorsN,minOpen] of [[14,1,0.95],[12,3,0.85],[12,4,0.75]]) {
    const rows=[];
    for(let level=1;level<=5;level++) {
      let opens=0, plays=0;
      for(let seed=1;seed<=runs;seed++) {
        const random=seeded(seed*7919+rack);
        const {hands}=deal(2,rack,random);
        const colors=paint(colorsN,random);
        const s=state({hand:hands[0],colors});
        const move=findMove(s,level,{random});
        if(move) { assert.deepEqual(checkPlay(s,move).errors,[]); opens++; }
        const o=state({hand:hands[1],colors});
        const opening=findMove(o,5,{random});
        const board=opening ? checkPlay(o,opening).board : [];
        const s2=state({board,jokers:opening?.jokers ?? {},hand:hands[0],colors,opened:true,turn:2});
        const later=findMove(s2,level,{random});
        if(later && !checkPlay(s2,later).errors.length)plays++;
      }
      rows.push(`level ${level}: opens ${Math.round(100*opens/runs)}%, plays once opened ${Math.round(100*plays/runs)}%`);
      assert.ok(opens/runs>=minOpen,`${rack} letters, ${colorsN} colours, level ${level}: opens ${opens}/${runs}`);
      assert.ok(plays/runs>=0.9,`${rack} letters, ${colorsN} colours, level ${level}: plays ${plays}/${runs}`);
    }
    t.diagnostic(`${rack} letters, ${colorsN} colour${colorsN>1 ? 's' : ''}: ${rows.join('; ')}`);
  }
});

test('bots: think time, about 70% of the clock at level 1 and 50% at level 5', ()=>{
  const random=seeded(5);
  const share=level=>{ let sum=0; for(let i=0;i<200;i++)sum+=thinkMs(level,60,random); return sum/200/60_000; };
  const shares=[1,2,3,4,5].map(share);
  assert.ok(Math.abs(shares[0]-0.70)<0.01 && Math.abs(shares[4]-0.50)<0.01,shares.join());
  for(let i=1;i<5;i++)assert.ok(shares[i]<shares[i-1],'each level is quicker');
  for(let i=0;i<50;i++) {
    const ms=thinkMs(5,30,random);
    assert.ok(ms>=30_000*(0.50-botRules.jitter)-1 && ms<=30_000*(0.50+botRules.jitter)+1);
  }
});

test('bots: letters arrive one by one, and the move lands at its time or when they are all down', ()=>{
  // Level 1, 3 letters, its time 42 s into a 60 s turn: letters 1.5 s apart, ending 1.2 s before the move.
  let r=botReveal(1,3,1_500,42_000,60_000);
  assert.deepEqual(r,{from:36_300,until:40_800,commitAt:42_000});
  // Level 5, 14 letters, its time at 5 s of 30: they need longer, so the move waits for them.
  r=botReveal(5,14,1_500,5_000,30_000);
  assert.equal(r.from,1_800);
  assert.equal(r.until-r.from,14*600);
  assert.equal(r.commitAt,r.until+botRules.settleMs);
  // Never past the clock: squeezed into what is left.
  r=botReveal(1,14,1_500,20_000,25_000);
  assert.ok(r.commitAt<=23_500 && r.from<=r.until && r.from>=1_800);
});

test('bots: names, levels and seats', ()=>{
  const seats=[{nickname:'דוב'}];
  for(let i=0;i<3;i++)seats.push(botSeat(seats,3,0,`bot-00000000000${i}`));
  assert.equal(new Set(seats.map(s=>s.nickname)).size,4,'each bot its own name');
  assert.ok(seats.slice(1).every(s=>s.bot && s.ready && s.platform==='bot'));
  assert.ok(botRules.names.includes(botName([])));
  assert.ok(validLevel(1) && validLevel(5) && !validLevel(0) && !validLevel(6) && !validLevel('3'));
  assert.equal(isBotTable([{},{bot:true}]),true);
  assert.equal(isBotTable([{},{},{bot:true}]),false,'with a friend it is a priced table');
  assert.equal(isBotTable([{},{}]),false);
});

test('bots: never pay, never collect; a bot-only table has no pot; a bot that wins gives the pot to the house', ()=>{
  const seats=[{},{bot:true},{},{bot:true}];
  assert.deepEqual(payouts(seats,50,10,0),{pot:100,cut:10,taker:0,payouts:[90,0,0,0]},'the pot is the humans\' prices');
  assert.deepEqual(payouts(seats,50,10,1,{values:[12,0,7,3]}),{pot:100,cut:100,taker:null,payouts:[0,0,0,0]},
    'a bot won: the house keeps the pot');
  assert.deepEqual(payouts(seats,50,10,1,{values:[12,0,7,3],botWin:'bestHuman'}),{pot:100,cut:10,taker:2,payouts:[0,0,90,0]},
    'the other rule: the human with the lowest hand');
  assert.deepEqual(payouts(seats,50,10,1,{values:[12,0,7,3],botWin:'refund'}).payouts,[50,0,50,0]);
  assert.deepEqual(payouts([{},{bot:true},{left:true},{bot:true}],50,10,3,{values:[12,0,1,3],botWin:'bestHuman'}).taker,0,
    'a human who left cannot take it');
  assert.deepEqual(payouts(seats,50,10,null).payouts,[50,0,50,0],'no winner: humans get their price back');
  assert.deepEqual(payouts([{},{bot:true}],50,10,0,{botTable:true}),{pot:0,cut:0,taker:null,payouts:[0,0]});
});

test('bots: the price of a game against bots is its own setting', ()=>{
  assert.equal(tableTuning(null).botPrice,botRulesPrice());
  assert.equal(tableTuning({wordTable:{botPrice:25}}).botPrice,25);
  assert.equal(tableTuning({wordTable:{botPrice:0}}).botPrice,0,'free');
  assert.equal(tableTuning({wordTable:{botPrice:-1}}).botPrice,botRulesPrice(),'invalid: the default');
  assert.equal(tableTuning({wordTable:{botPrice:'5'}}).botPrice,botRulesPrice());
  assert.deepEqual(tableTuning({wordTable:{botPrice:5000,stakes:[10]}}).stakes,[10],'a bad bot price leaves the prices');
  assert.equal(tableTuning({economy:{enabled:false},wordTable:{botPrice:25}}).botPrice,0,'diamonds off: free');
});
const botRulesPrice=()=>10;

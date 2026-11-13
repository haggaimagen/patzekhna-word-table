// The word table's rules (src/table.js, README.md). Swift's Tests/WordTableTests.swift runs the same
// cases against Models/WordTable.swift.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TILES,ALPHABET,tileOf,tableRules,tableSettings,deal,paint,colorOf,wordText,wordKey,checkPlay,handValue,nextSeat,
  finalScores,readBoard,readAsked,tally} from '../src/table.js';
import {isWord,dictionarySize,dictionaryVersion} from '../src/dictionary.js';

// Tile ids by letter, in box order: ids('ש',2) → the first two ש tiles.
const ids=(letter,n=1,skip=0)=>TILES.filter(t=>t.letter===letter).slice(skip,skip+n).map(t=>t.id);
const spell=(word,used=new Set())=>[...word].map(l=>{
  const base={'ך':'כ','ם':'מ','ן':'נ','ף':'פ','ץ':'צ'}[l] ?? l;
  const id=TILES.find(t=>t.letter===base && !used.has(t.id)).id;
  used.add(id);
  return id;
});
const JOKER=TILES.find(t=>t.joker).id;
const settings=tableSettings({});
const state=(over={})=>({board:[],jokers:{},hand:[],opened:false,settings,...over});

test('the box: 106 tiles, 104 letters and 2 jokers, fixed ids', ()=>{
  assert.equal(TILES.length,106);
  assert.equal(TILES.filter(t=>t.joker).length,2);
  assert.equal(TILES[0].id,'t0');
  assert.equal(TILES[0].letter,'א');
  assert.equal(TILES[105].id,'t105');
  assert.equal(ALPHABET.length,22);
});

test('settings take only the offered choices', ()=>{
  assert.deepEqual(tableSettings({rackSize:7,turnSeconds:30}).rackSize,7);
  assert.equal(tableSettings({rackSize:9}).rackSize,14);
  assert.equal(tableSettings({turnSeconds:5}).turnSeconds,60);
});

test('deal gives each seat its rack and keeps the rest in the pool', ()=>{
  const {hands,pool}=deal(4,14,()=>0.3);
  hands.forEach(h=>assert.equal(h.length,14));
  assert.equal(pool.length,106-56);
  assert.equal(new Set([...hands.flat(),...pool]).size,106);
});

test('final forms only at the end of a word', ()=>{
  assert.equal(wordText(spell('ממנ')),'ממן');
  assert.equal(wordText(spell('מ')),'מ');
  assert.equal(wordText([JOKER],{[JOKER]:'צ'}),'צ');
  assert.equal(wordText([...spell('ק'),JOKER],{[JOKER]:'צ'}),'קץ');
});

test('opening: new words of own tiles, enough points', ()=>{
  const shalom=spell('שלומ');                       // 2+1+1+1 = 5
  const r1=checkPlay(state({hand:shalom}),{board:[{id:'w1',tiles:shalom}]});
  assert.deepEqual(r1.errors.map(e=>e.code),['opening']);
  const used=new Set(shalom);
  const sefer=spell('ספר',used);                    // 3+3+1 = 7
  const r2=checkPlay(state({hand:[...shalom,...sefer]}),{board:[{id:'w1',tiles:shalom},{id:'w2',tiles:sefer}]});
  assert.deepEqual(r2.errors,[]);
  assert.equal(r2.points,12);
  assert.deepEqual(r2.words,['שלום','ספר']);
  assert.deepEqual(r2.hand,[]);
});

test('nothing played, short words', ()=>{
  const shalom=spell('שלומ');
  const board=[{id:'w1',tiles:shalom}];
  assert.deepEqual(checkPlay(state({board,opened:true}),{board}).errors.map(e=>e.code),['nothing']);
  const two=spell('אב');
  const r=checkPlay(state({hand:two,opened:true}),{board:[{id:'w2',tiles:two}]});
  assert.deepEqual(r.errors,[{code:'short',word:'אב'}]);
});

test('before the opening the words on the table are locked', ()=>{
  const shalom=spell('שלומ');
  const board=[{id:'w1',tiles:shalom}];
  const used=new Set(shalom);
  const extra=spell('ה',used);
  const r=checkPlay(state({board,hand:extra}),{board:[{id:'w1',tiles:[...shalom,...extra]}]});
  assert.ok(r.errors.some(e=>e.code==='locked'));
  // After the opening the same move is fine: split and extend.
  const r2=checkPlay(state({board,hand:extra,opened:true}),
    {board:[{id:'w1',tiles:[...shalom.slice(0,2),...extra]},{id:'w2',tiles:shalom.slice(2)}]});
  assert.deepEqual(r2.errors.map(e=>e.code),['short']);   // ום is short
});

test('board tiles never leave, and only the hand plays', ()=>{
  const shalom=spell('שלומ');
  const board=[{id:'w1',tiles:shalom}];
  assert.throws(()=>checkPlay(state({board,opened:true}),{board:[{id:'w1',tiles:shalom.slice(1)}]}),/left the board/);
  const other=ids('ת');
  assert.throws(()=>checkPlay(state({board,opened:true}),{board:[{id:'w1',tiles:[...shalom,...other]}]}),/Not your tile/);
});

test('malformed boards are refused', ()=>{
  assert.throws(()=>readBoard([{id:'w1',tiles:['t0','t0']}]),/Invalid board/);
  assert.throws(()=>readBoard([{id:'w1',tiles:[]}]),/Invalid board/);
  assert.throws(()=>readBoard([{id:'w 1',tiles:['t0']}]),/Invalid board/);
  assert.throws(()=>readBoard([{id:'w1',tiles:['t999']}]),/Invalid board/);
  assert.throws(()=>readBoard('x'),/Invalid board/);
});

test('jokers: a letter when played; kept on the table unless swapped out by the real letter', ()=>{
  const used=new Set();
  const ab=spell('אב',used);
  const r=checkPlay(state({hand:[...ab,JOKER],opened:true}),{board:[{id:'w1',tiles:[...ab,JOKER]}]});
  assert.deepEqual(r.errors.map(e=>e.code),['joker']);
  const ok=checkPlay(state({hand:[...ab,JOKER],opened:true}),{board:[{id:'w1',tiles:[...ab,JOKER]}],jokers:{[JOKER]:'א'}});
  assert.deepEqual(ok.errors,[]);
  assert.equal(ok.words[0],'אבא');
  // Later: the joker stands for א. Changing it needs a real א from the hand.
  const board=[{id:'w1',tiles:[...ab,JOKER]}];
  const jokers={[JOKER]:'א'};
  const more=spell('דג',used);
  assert.throws(()=>checkPlay(state({board,jokers,hand:more,opened:true}),
    {board:[{id:'w1',tiles:[...ab,JOKER,...more]}],jokers:{[JOKER]:'ת'}}),/keeps its letter/);
  const alef=spell('א',used);
  const swap=checkPlay(state({board,jokers,hand:[...alef,...more],opened:true}),
    {board:[{id:'w1',tiles:[...ab,...alef]},{id:'w2',tiles:[JOKER,...more]}],jokers:{[JOKER]:'ת'}});
  assert.deepEqual(swap.errors,[]);
});

test('turn order skips seats that left', ()=>{
  const seats=[{left:false},{left:true},{left:false}];
  assert.equal(nextSeat(seats,0),2);
  assert.equal(nextSeat(seats,2),0);
  assert.equal(nextSeat([{left:false},{left:true}],0),0);
});

test('scores: losers pay their hand, the winner collects; blocked → the lowest hand', ()=>{
  const seats=[{left:false},{left:false},{left:false}];
  assert.deepEqual(finalScores(seats,[0,5,7],0),{winner:0,scores:[12,-5,-7]});
  assert.deepEqual(finalScores(seats,[6,3,7],null),{winner:1,scores:[-6,10,-7]});
  assert.deepEqual(finalScores([{left:false},{left:true}],[4,1],null),{winner:0,scores:[-4,0]});
  assert.equal(handValue([JOKER]),tableRules.jokerHandPenalty);
  assert.equal(handValue(ids('ז')),4);
  assert.equal(tileOf('t0').value,1);
});

test('colours: chosen in the lobby, about half the letters painted, never a joker', ()=>{
  assert.equal(tableSettings({}).colors,1);
  assert.equal(tableSettings({colors:3}).colors,3);
  assert.equal(tableSettings({colors:5}).colors,1);
  assert.deepEqual(paint(1),{});
  let seed=1;
  const random=()=>((seed=(seed*16807)%2147483647)-1)/2147483646;
  const painted=paint(4,random);
  const count=Object.keys(painted).length;
  assert.ok(count>30 && count<75,`about half of 104 painted, got ${count}`);
  assert.deepEqual(new Set(Object.values(painted)),new Set([1,2,3]));
  assert.ok(TILES.filter(t=>t.joker).every(t=>painted[t.id]==null));
  assert.equal(colorOf(JOKER,painted),null);
  assert.equal(colorOf('t0',{}),0);
});

test('colours: a word is one colour, a joker fits any', ()=>{
  const used=new Set();
  const word=spell('שלומ',used);
  const colors={[word[0]]:2,[word[1]]:2,[word[2]]:2,[word[3]]:2};
  const one=checkPlay(state({hand:word,opened:true,colors}),{board:[{id:'w1',tiles:word}]});
  assert.deepEqual(one.errors,[]);
  const mixed=checkPlay(state({hand:word,opened:true,colors:{...colors,[word[3]]:1}}),{board:[{id:'w1',tiles:word}]});
  assert.deepEqual(mixed.errors,[{code:'colors',word:'שלום'}]);
  const plainAndColour=checkPlay(state({hand:word,opened:true,colors:{[word[0]]:1}}),{board:[{id:'w1',tiles:word}]});
  assert.deepEqual(plainAndColour.errors.map(e=>e.code),['colors']);
  const withJoker=checkPlay(state({hand:[...word.slice(0,3),JOKER],opened:true,colors}),
    {board:[{id:'w1',tiles:[...word.slice(0,3),JOKER]}],jokers:{[JOKER]:'ה'}});
  assert.deepEqual(withJoker.errors,[]);
});

test('the dictionary: inflected forms in, prefixed forms out, keys without final letters', ()=>{
  assert.equal(dictionaryVersion,'he-v1');
  assert.ok(dictionarySize()>300_000);
  for(const word of ['שלומ','בית','שירימ','שירינו','הלכנו','לחמ','מימ','שמש','הייתה','היתה','אמיתי'])
    assert.ok(isWord(word),word);
  for(const word of ['הבית','ובית','והלכנו','בשירימ','שלום','אב','qwe','בבבב'])
    assert.ok(!isWord(word),word);
});

test('words the dictionary lacks stop a turn, unless the table voted them in', ()=>{
  const used=new Set();
  const good=spell('שלומ',used), bad=spell('בבבב',used);
  const r=checkPlay(state({hand:[...good,...bad],opened:true,isWord}),{board:[{id:'w1',tiles:good},{id:'w2',tiles:bad}]});
  assert.deepEqual(r.errors,[{code:'unknown',words:[{key:'בבבב',text:'בבבב'}]}]);
  const ok=checkPlay(state({hand:[...good,...bad],opened:true,isWord,accepted:['בבבב']}),
    {board:[{id:'w1',tiles:good},{id:'w2',tiles:bad}]});
  assert.deepEqual(ok.errors,[]);
  // Words already on the board are not checked again.
  const old=checkPlay(state({board:[{id:'w2',tiles:bad}],hand:good,opened:true,isWord}),
    {board:[{id:'w1',tiles:good},{id:'w2',tiles:bad}]});
  assert.deepEqual(old.errors,[]);
  assert.equal(wordKey(good),'שלומ');
  assert.equal(wordKey([...good.slice(0,3),JOKER],{[JOKER]:'מ'}),'שלומ');
});

test('asking the table: up to three unknown words; a majority of all who may vote', ()=>{
  assert.deepEqual(readAsked([{key:'בבבב',text:'בבבב'}],isWord),[{key:'בבבב',text:'בבבב'}]);
  assert.throws(()=>readAsked([{key:'שלומ',text:'שלום'}],isWord),/Already a word/);
  assert.throws(()=>readAsked([{key:'בבבב'}],isWord,['בבבב']),/Already a word/);
  assert.throws(()=>readAsked([],isWord),/Invalid/);
  assert.throws(()=>readAsked([{key:'אב'}],isWord),/Invalid/);
  assert.throws(()=>readAsked([{key:'בבבב'},{key:'גגגג'},{key:'דדדד'},{key:'הההה'}],isWord),/Invalid/);
  const vote={words:[{key:'א1'},{key:'ב2'}],votes:{'1':['א1'],'2':['א1','ב2']}};
  assert.deepEqual(tally(vote,[1,2,3]).accepted.map(w=>w.key),['א1']);   // 2 of 3, and 1 of 3
  assert.deepEqual(tally(vote,[1,2]).accepted.map(w=>w.key),['א1']);     // 2 of 2, and 1 of 2 is a tie
  assert.deepEqual(tally({words:[{key:'א1'}],votes:{'1':['א1']}},[1]).accepted.length,1);
  assert.deepEqual(tally({words:[{key:'א1'}],votes:{}},[1]).accepted.length,0);
});

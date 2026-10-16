'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../lib/game');

function fresh(seats = 2) {
  return G.newState({ seats, names: ['A', 'B', 'C', 'D'].slice(0, seats), bots: [false, false, false, false] });
}

test('new 2-player match starts on opposite corners with str 2', () => {
  const s = fresh(2);
  assert.equal(s.board[0].owner, 0);
  assert.equal(s.board[35].owner, 1);
  assert.equal(s.board[0].str, 2);
  assert.equal(s.current, 0);
  assert.equal(s.round, 1);
});

test('legal moves from a corner: 2 expands + 1 fortify, no attack', () => {
  const s = fresh(2);
  const m = G.legalMoves(s, 0);
  assert.deepEqual(m.filter((x) => x.type === 'expand').map((x) => x.to).sort(), [1, 6]);
  assert.equal(m.filter((x) => x.type === 'fortify').length, 1);
  assert.equal(m.filter((x) => x.type === 'attack').length, 0);
  assert.deepEqual(G.legalMoves(s, 1), [], 'not player 1 turn');
});

test('expand then turn passes; round increments after all players moved', () => {
  let s = fresh(2);
  s = G.applyMove(s, 0, { type: 'expand', to: 1 });
  assert.equal(s.board[1].str, 1);
  assert.equal(s.current, 1);
  assert.equal(s.round, 1);
  s = G.applyMove(s, 1, { type: 'expand', to: 34 });
  assert.equal(s.current, 1, 'snake order: round 2 starts with the last seat');
  assert.equal(s.round, 2);
  assert.equal(s.turn, 3);
  s = G.applyMove(s, 1, { type: 'expand', to: 29 });
  assert.equal(s.current, 0);
  s = G.applyMove(s, 0, { type: 'expand', to: 7 });
  assert.equal(s.round, 3);
  assert.equal(s.current, 0, 'round 3 starts with seat 0 again');
});

test('fortify caps at 3', () => {
  let s = fresh(2);
  s = G.applyMove(s, 0, { type: 'fortify', at: 0 });
  s = G.applyMove(s, 1, { type: 'fortify', at: 35 });
  assert.equal(s.board[0].str, 3);
  assert.equal(s.board[35].str, 3);
  assert.ok(!G.legalMoves(s, 1).some((m) => m.type === 'fortify' && m.at === 35));
  s = G.applyMove(s, 1, { type: 'expand', to: 34 });
  assert.ok(!G.legalMoves(s, 0).some((m) => m.type === 'fortify' && m.at === 0));
  assert.ok(!G.legalMoves(s, 0).some((m) => m.type === 'fortify' && m.at === 0));
});

test('attack needs str(from) >= str(to); target becomes str 1, attacker keeps max(1, diff)', () => {
  let s = fresh(2);
  s.board[1] = { owner: 1, str: 1 };            // A(2) vs B(1)
  assert.ok(G.legalMoves(s, 0).some((m) => m.type === 'attack' && m.from === 0 && m.to === 1));
  s = G.applyMove(s, 0, { type: 'attack', from: 0, to: 1 });
  assert.deepEqual(s.board[1], { owner: 0, str: 1 });
  assert.equal(s.board[0].str, 1);
  const s2 = fresh(2);
  s2.board[1] = { owner: 1, str: 2 };           // equal: legal, attacker drops to 1
  assert.ok(G.legalMoves(s2, 0).some((m) => m.type === 'attack'));
  const s3 = fresh(2);
  s3.board[1] = { owner: 1, str: 3 };           // stronger: illegal
  assert.ok(!G.legalMoves(s3, 0).some((m) => m.type === 'attack'));
});

test('illegal move throws with code ILLEGAL and legalMoves attached', () => {
  const s = fresh(2);
  assert.throws(() => G.applyMove(s, 0, { type: 'expand', to: 20 }), (e) => e.code === 'ILLEGAL' && Array.isArray(e.legalMoves));
  assert.throws(() => G.applyMove(s, 1, { type: 'expand', to: 34 }), (e) => e.code === 'ILLEGAL');
});

test('elimination ends the match early', () => {
  let s = fresh(2);
  s.board[35] = { owner: 1, str: 1 };
  s.board[34] = { owner: 0, str: 3 };
  s = G.applyMove(s, 0, { type: 'attack', from: 34, to: 35 });
  assert.equal(s.status, 'finished');
  assert.equal(s.winner, 0);
});

test('a full bot-vs-bot match finishes within ROUNDS and produces scores + log', () => {
  let seed = 7;
  const rng = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (const seats of [2, 3, 4]) {
    let s = G.newState({ seats, names: [], bots: [true, true, true, true] });
    let guard = 0;
    while (s.status === 'playing' && guard++ < 200) s = G.applyMove(s, s.current, G.botMove(s, s.current, rng));
    assert.equal(s.status, 'finished', `seats=${seats}`);
    assert.ok(s.round <= G.ROUNDS);
    assert.equal(s.scores.length, seats);
    assert.ok(s.log.length >= seats * 2);
    for (const sc of s.scores) assert.equal(sc.total, sc.land + sc.group);
  }
});

test('scoring: land (springs worth 2) + largest group', () => {
  const s = fresh(2);
  s.board[1] = { owner: 0, str: 1 };
  s.board[6] = { owner: 0, str: 1 };
  s.board[14] = { owner: 0, str: 3 }; // isolated spring (row 2, col 2)
  const sc = G.scoreOf(s, 0);
  assert.deepEqual(sc, { cells: 4, land: 5, group: 3, strength: 7, total: 8 });
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handle } = require('../lib/api');
const store = require('../lib/store');

test.beforeEach(() => store._reset());

test('create -> join auto-starts a 2-seat match; moves alternate; bots fill when asked', async () => {
  const c = await handle('POST', '/api/matches', {}, { name: 'Ada', seats: 2, fillWithBots: false });
  assert.equal(c.status, 201);
  assert.equal(c.body.phase, 'lobby');
  const code = c.body.code;
  const j = await handle('POST', `/api/matches/${code}/join`, {}, { name: 'Bob' });
  assert.equal(j.status, 200);
  assert.equal(j.body.phase, 'playing');
  assert.equal(j.body.state.current, 0);
  assert.ok(j.body.legalMoves.length > 0);
  // Bob cannot move first
  const bad = await handle('POST', `/api/matches/${code}/move`, {}, { token: j.body.token, type: 'expand', to: 34 });
  assert.equal(bad.status, 409);
  // Ada expands
  const m1 = await handle('POST', `/api/matches/${code}/move`, {}, { token: c.body.token, type: 'expand', to: 1 });
  assert.equal(m1.status, 200);
  assert.equal(m1.body.state.current, 1);
  // illegal move returns legalMoves
  const ill = await handle('POST', `/api/matches/${code}/move`, {}, { token: j.body.token, type: 'expand', to: 20 });
  assert.equal(ill.status, 400);
  assert.ok(Array.isArray(ill.body.legalMoves) && ill.body.legalMoves.length);
  // state view with token shows `you`
  const v = await handle('GET', `/api/matches/${code}`, { token: j.body.token }, {});
  assert.equal(v.body.you.playerId, 1);
  assert.equal(v.status, 200);
});

test('host start fills seats with bots and the bots play until it is the human turn', async () => {
  const c = await handle('POST', '/api/matches', {}, { name: 'Ada', seats: 4 });
  const code = c.body.code;
  const notHost = await handle('POST', `/api/matches/${code}/start`, {}, { token: 'nope' });
  assert.equal(notHost.status, 401);
  const s = await handle('POST', `/api/matches/${code}/start`, {}, { token: c.body.token });
  assert.equal(s.status, 200);
  assert.equal(s.body.players.length, 4);
  assert.equal(s.body.players.filter((p) => p.bot).length, 3);
  assert.equal(s.body.state.current, 0, 'human (seat 0) moves first in round 1');
  // after the human moves, the three bots move, then round 2 (snake) starts with seat 3 (bot) ... until seat 0 again
  const m = await handle('POST', `/api/matches/${code}/move`, {}, { token: c.body.token, type: 'expand', to: 1 });
  assert.equal(m.status, 200);
  assert.equal(m.body.state.current, 0);
  assert.equal(m.body.state.round, 2);
  assert.ok(m.body.state.log.length >= 7);
});

test('a human can finish a whole match against a bot via the API; log and replay work', async () => {
  const c = await handle('POST', '/api/matches', {}, { name: 'Ada', seats: 2 });
  const code = c.body.code;
  await handle('POST', `/api/matches/${code}/start`, {}, { token: c.body.token });
  let guard = 0;
  let v = await handle('GET', `/api/matches/${code}`, { token: c.body.token }, {});
  while (v.body.state.status === 'playing' && guard++ < 100) {
    const moves = v.body.legalMoves;
    const pick = moves.find((m) => m.type === 'attack') || moves.find((m) => m.type === 'expand') || moves[0];
    const r = await handle('POST', `/api/matches/${code}/move`, {}, { token: c.body.token, ...pick });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    v = r;
  }
  assert.equal(v.body.state.status, 'finished');
  assert.ok(v.body.state.scores);
  const log = await handle('GET', `/api/matches/${code}/log`, {}, {});
  assert.ok(log.body.log.length >= 24);
  const rep = await handle('GET', `/api/matches/${code}/replay/1`, {}, {});
  assert.equal(rep.status, 200);
  assert.equal(rep.body.state.turn, 1);
  const rep5 = await handle('GET', `/api/matches/${code}/replay/5`, {}, {});
  assert.equal(rep5.body.state.turn, 5);
  const after = await handle('POST', `/api/matches/${code}/move`, {}, { token: c.body.token, type: 'pass' });
  assert.equal(after.status, 409);
});

test('docs at /api; 404 for unknown match', async () => {
  const d = await handle('GET', '/api', {}, {});
  assert.equal(d.status, 200);
  assert.ok(d.body.endpoints.length >= 6);
  const n = await handle('GET', '/api/matches/ZZZZZ', {}, {});
  assert.equal(n.status, 404);
});

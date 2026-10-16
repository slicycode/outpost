'use strict';
// Transport-agnostic HTTP API for Outpost. handle() returns { status, body }.
const crypto = require('node:crypto');
const G = require('./game');
const store = require('./store');

const TURN_SECONDS = 90;      // a human who idles this long gets a bot move played for them
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeCode() {
  let s = '';
  const bytes = crypto.randomBytes(5);
  for (let i = 0; i < 5; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s;
}
function makeToken() { return crypto.randomBytes(16).toString('hex'); }
function httpError(status, message, extra = {}) { const e = new Error(message); e.status = status; e.extra = extra; return e; }
function cleanName(n, fallback) { const s = String(n || '').trim().slice(0, 24); return s || fallback; }

const DOCS = {
  name: 'Outpost',
  version: '1.0',
  rules: 'Outpost is a 6x6 turn-based territory game for 2-4 players. Each turn do ONE thing: expand into an empty cell next to one you own, fortify a cell you own (+1 strength, max 3), or attack an adjacent enemy cell whose strength is no higher than your attacking cell (you capture it at strength 1; your attacker keeps max(1, difference)). The four centre cells are springs worth 2 points. After 12 rounds (snake order) the score is land value plus the size of your largest connected group; highest wins, ties broken by total strength. A player with no cells is out.',
  endpoints: [
    { method: 'POST', path: '/api/matches', body: { name: 'string', seats: '2-4 (default 2)', fillWithBots: 'bool (default true)' }, returns: '{ code, playerId, token, state }' },
    { method: 'POST', path: '/api/matches/{code}/join', body: { name: 'string' }, returns: '{ code, playerId, token, state }' },
    { method: 'POST', path: '/api/matches/{code}/start', body: { token: 'host token' }, note: 'fills empty seats with bots and starts; auto-starts when all seats are humans' },
    { method: 'GET', path: '/api/matches/{code}?token=...', returns: '{ state, you, legalMoves }  (legalMoves for the player to move; poll this ~1/s)' },
    { method: 'POST', path: '/api/matches/{code}/move', body: { token: 'string', type: 'expand|fortify|attack|pass', to: 'cell index', from: 'cell index', at: 'cell index' }, returns: '{ state, legalMoves } or 400 { error, legalMoves }' },
    { method: 'GET', path: '/api/matches/{code}/log', returns: '{ log: [{ turn, round, player, move, note }] }' },
    { method: 'GET', path: '/api/matches/{code}/replay/{turn}', returns: '{ state } as it was before that turn was played' },
  ],
  cells: 'index = row*6 + col, rows and cols 0..5; board[i] is null or { owner, str }',
  tip: 'A bot in 10 lines: poll GET until state.current === you.playerId, pick a move from legalMoves, POST it. See bot/sample-bot.js.',
};

function view(rec, token) {
  const me = token ? rec.players.find((p) => p.token === token) : null;
  const state = rec.state ? G.publicState(rec.state) : null;
  const lobby = {
    code: rec.code,
    phase: rec.phase,
    seats: rec.seats,
    fillWithBots: rec.fillWithBots,
    players: rec.players.map((p) => ({ id: p.id, name: p.name, bot: p.bot })),
    turnStartedAt: rec.turnStartedAt || null,
    turnSeconds: TURN_SECONDS,
  };
  const out = { ...lobby, state };
  if (me) out.you = { playerId: me.id, name: me.name };
  if (state && state.status === 'playing') out.legalMoves = G.legalMoves(state, state.current);
  return out;
}

function runBots(rec, now = Date.now()) {
  // play bot turns, and auto-play for humans who have idled past the clock
  let changed = false;
  let guard = 0;
  while (rec.state && rec.state.status === 'playing' && guard++ < 64) {
    const cur = rec.state.current;
    const pl = rec.players[cur];
    const idle = (now - (rec.turnStartedAt || now)) / 1000;
    if (pl.bot) {
      rec.state = G.applyMove(rec.state, cur, G.botMove(rec.state, cur));
    } else if (idle > TURN_SECONDS) {
      const m = G.botMove(rec.state, cur);
      rec.state = G.applyMove(rec.state, cur, m);
      rec.state.log[rec.state.log.length - (rec.state.status === 'finished' ? 2 : 1)].note += ' (auto-played: turn clock expired)';
    } else break;
    rec.turnStartedAt = now;
    changed = true;
  }
  return changed;
}

function startMatch(rec) {
  while (rec.players.length < rec.seats) {
    const id = rec.players.length;
    rec.players.push({ id, name: `Bot ${id + 1}`, bot: true, token: makeToken() });
  }
  rec.state = G.newState({ seats: rec.seats, names: rec.players.map((p) => p.name), bots: rec.players.map((p) => p.bot) });
  rec.initial = structuredClone(rec.state);
  rec.phase = 'playing';
  rec.turnStartedAt = Date.now();
  runBots(rec);
}

async function withRecord(code, mutate) {
  // optimistic concurrency: load, mutate, save; retry on conflict
  for (let attempt = 0; attempt < 4; attempt++) {
    const rec = await store.get(code);
    if (!rec) throw httpError(404, `no match with code ${code}`);
    const result = await mutate(rec);
    try {
      await store.update(rec);
      return result;
    } catch (e) {
      if (e.code !== 'CONFLICT') throw e;
    }
  }
  throw httpError(409, 'match is busy, retry');
}

async function handle(method, path, query = {}, body = {}) {
  try {
    const parts = path.replace(/^\/api\/?/, '').split('/').filter(Boolean);
    if (parts.length === 0) return { status: 200, body: DOCS };
    if (parts[0] !== 'matches') throw httpError(404, 'not found');

    // POST /api/matches
    if (parts.length === 1 && method === 'POST') {
      const seats = body.seats === undefined ? 2 : Number(body.seats);
      if (!Number.isInteger(seats) || seats < 2 || seats > 4) throw httpError(400, 'seats must be an integer from 2 to 4');
      const rec = {
        code: makeCode(),
        phase: 'lobby',
        seats,
        fillWithBots: body.fillWithBots === undefined ? true : !!body.fillWithBots,
        players: [{ id: 0, name: cleanName(body.name, 'Player 1'), bot: false, token: makeToken() }],
        state: null,
        initial: null,
        turnStartedAt: null,
      };
      for (let i = 0; i < 5; i++) {
        try { await store.create(rec); break; } catch (e) { if (e.code !== 'CONFLICT' || i === 4) throw e; rec.code = makeCode(); }
      }
      return { status: 201, body: { code: rec.code, playerId: 0, token: rec.players[0].token, ...view(rec, rec.players[0].token) } };
    }

    const code = String(parts[1] || '').toUpperCase();
    const sub = parts[2];

    // GET /api/matches/:code
    if (!sub && method === 'GET') {
      const rec = await store.get(code);
      if (!rec) throw httpError(404, `no match with code ${code}`);
      if (rec.phase === 'playing' && runBots(rec)) {
        try { await store.update(rec); } catch (e) { if (e.code !== 'CONFLICT') throw e; }
      }
      return { status: 200, body: view(rec, query.token) };
    }

    if (sub === 'log' && method === 'GET') {
      const rec = await store.get(code);
      if (!rec) throw httpError(404, `no match with code ${code}`);
      return { status: 200, body: { code, log: rec.state ? rec.state.log : [] } };
    }

    if (sub === 'replay' && method === 'GET') {
      const rec = await store.get(code);
      if (!rec || !rec.initial) throw httpError(404, 'no replay available');
      const turn = Math.max(1, Number(parts[3] || 1));
      let s = structuredClone(rec.initial);
      for (const entry of rec.state.log) {
        if (!entry.move || entry.turn >= turn) break;
        s = G.applyMove(s, entry.player, entry.move);
      }
      return { status: 200, body: { code, turn, totalTurns: rec.state.turn, state: G.publicState(s) } };
    }

    if (sub === 'join' && method === 'POST') {
      const result = await withRecord(code, (rec) => {
        if (rec.phase !== 'lobby') throw httpError(409, 'match already started');
        if (rec.players.length >= rec.seats) throw httpError(409, 'match is full');
        const id = rec.players.length;
        const p = { id, name: cleanName(body.name, `Player ${id + 1}`), bot: false, token: makeToken() };
        rec.players.push(p);
        if (rec.players.length === rec.seats) startMatch(rec);
        return { code, playerId: id, token: p.token, ...view(rec, p.token) };
      });
      return { status: 200, body: result };
    }

    if (sub === 'start' && method === 'POST') {
      const result = await withRecord(code, (rec) => {
        const me = rec.players.find((p) => p.token === body.token);
        if (!me) throw httpError(401, 'unknown token');
        if (me.id !== 0) throw httpError(403, 'only the host (player 0) can start');
        if (rec.phase !== 'lobby') throw httpError(409, 'match already started');
        startMatch(rec);
        return view(rec, body.token);
      });
      return { status: 200, body: result };
    }

    if (sub === 'move' && method === 'POST') {
      const result = await withRecord(code, (rec) => {
        const me = rec.players.find((p) => p.token === body.token);
        if (!me) throw httpError(401, 'unknown token');
        if (rec.phase !== 'playing') throw httpError(409, 'match has not started');
        runBots(rec);
        if (rec.state.status !== 'playing') throw httpError(409, 'match is finished', { state: G.publicState(rec.state) });
        if (rec.state.current !== me.id) throw httpError(409, `not your turn (player ${rec.state.current} to move)`, { legalMoves: [] });
        const move = { type: body.type };
        for (const k of ['to', 'from', 'at']) if (body[k] !== undefined && body[k] !== null) move[k] = Number(body[k]);
        try {
          rec.state = G.applyMove(rec.state, me.id, move);
        } catch (e) {
          if (e.code === 'ILLEGAL') throw httpError(400, `illegal move: ${e.message}`, { legalMoves: e.legalMoves || G.legalMoves(rec.state, me.id) });
          throw e;
        }
        rec.turnStartedAt = Date.now();
        runBots(rec);
        return view(rec, body.token);
      });
      return { status: 200, body: result };
    }

    throw httpError(404, 'not found');
  } catch (e) {
    if (e.status) return { status: e.status, body: { error: e.message, ...(e.extra || {}) } };
    console.error(e);
    return { status: 500, body: { error: 'internal error' } };
  }
}

module.exports = { handle, DOCS, TURN_SECONDS };

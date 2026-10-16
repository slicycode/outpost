'use strict';
// Outpost — pure game rules. No I/O, no randomness except where a `rng` is passed.
//
// Board: 6x6 grid, cells indexed 0..35 (row-major). The four centre cells are SPRINGS worth 2 points each. Each cell: null or { owner: playerIndex, str: 1..3 }.
// Players: 2..4. Each starts on a corner with strength 2.
// A match lasts ROUNDS rounds; in each round every living player moves once. Turn order snakes:
// odd rounds go seat 0 -> last, even rounds go last -> seat 0 (removes last-mover advantage).
// Moves:
//   expand  {to}        claim an EMPTY cell orthogonally adjacent to a cell you own -> str 1
//   fortify {at}        +1 strength on a cell you own (max 3)
//   attack  {from, to}  from a cell you own into an adjacent ENEMY cell whose strength is <= yours:
//                       target becomes yours with str 1; your attacking cell drops to max(1, str(from) - str(to))
//                       (attack beats expansion, fortify beats attack, expansion beats fortify on tempo)
//   pass                only legal when you have no other legal move
// End: after ROUNDS rounds, or when only one player still owns cells.
// Score: sum of cell values (1, springs 2) + size of your largest orthogonally-connected group. Tie-break: total strength.

const SIZE = 6;
const CELLS = SIZE * SIZE;
const ROUNDS = 12;
const MAX_STR = 3;
const CORNERS = [0, CELLS - 1, SIZE - 1, CELLS - SIZE];
const SPRINGS = [idx0(2, 2), idx0(2, 3), idx0(3, 2), idx0(3, 3)];
function idx0(r, c) { return r * SIZE + c; }
const HANDICAP = { 3: { 2: [idx0(1, 4)] }, 4: { 2: [idx0(1, 4)], 3: [idx0(4, 1)] } };
function cellValue(i) { return SPRINGS.includes(i) ? 2 : 1; } // TL, BR, TR, BL (opposite corners for 2 players)
const COLORS = ['#ff7a45', '#3fb8ff', '#9ad24a', '#e86bd0'];

function rc(i) { return [Math.floor(i / SIZE), i % SIZE]; }
function idx(r, c) { return r * SIZE + c; }
function neighbors(i) {
  const [r, c] = rc(i);
  const out = [];
  if (r > 0) out.push(idx(r - 1, c));
  if (r < SIZE - 1) out.push(idx(r + 1, c));
  if (c > 0) out.push(idx(r, c - 1));
  if (c < SIZE - 1) out.push(idx(r, c + 1));
  return out;
}

function newState({ seats, names, bots }) {
  if (!Number.isInteger(seats) || seats < 2 || seats > 4) throw new Error('seats must be 2..4');
  const board = Array(CELLS).fill(null);
  const players = [];
  for (let p = 0; p < seats; p++) {
    board[CORNERS[p]] = { owner: p, str: 2 };
    // handicap: in 3- and 4-player games the later corners are squeezed between two rivals; give them a second cell
    for (const extra of (HANDICAP[seats] && HANDICAP[seats][p]) || []) board[extra] = { owner: p, str: 1 };
    players.push({ id: p, name: names[p] || `Player ${p + 1}`, bot: !!bots[p], color: COLORS[p], alive: true });
  }
  return {
    size: SIZE,
    rounds: ROUNDS,
    maxStr: MAX_STR,
    springs: SPRINGS.slice(),
    board,
    players,
    round: 1,
    current: 0,       // index of player to move
    turn: 1,          // global move counter (1-based)
    status: 'playing',
    log: [],          // { turn, round, player, move, note }
    winner: null,     // player index, or null for draw / unfinished
    scores: null,
  };
}

function cellsOf(state, p) {
  const out = [];
  for (let i = 0; i < CELLS; i++) if (state.board[i] && state.board[i].owner === p) out.push(i);
  return out;
}

function largestGroup(state, p) {
  const seen = new Set();
  let best = 0;
  for (let i = 0; i < CELLS; i++) {
    const cell = state.board[i];
    if (!cell || cell.owner !== p || seen.has(i)) continue;
    let size = 0;
    const stack = [i];
    seen.add(i);
    while (stack.length) {
      const j = stack.pop();
      size++;
      for (const n of neighbors(j)) {
        const cn = state.board[n];
        if (cn && cn.owner === p && !seen.has(n)) { seen.add(n); stack.push(n); }
      }
    }
    if (size > best) best = size;
  }
  return best;
}

function scoreOf(state, p) {
  const cells = cellsOf(state, p);
  const strength = cells.reduce((s, i) => s + state.board[i].str, 0);
  const group = largestGroup(state, p);
  const land = cells.reduce((s, i) => s + cellValue(i), 0);
  return { cells: cells.length, land, group, strength, total: land + group };
}

function legalMoves(state, p) {
  if (state.status !== 'playing' || state.current !== p) return [];
  const moves = [];
  const mine = cellsOf(state, p);
  const expandTargets = new Set();
  for (const i of mine) {
    const cell = state.board[i];
    if (cell.str < MAX_STR) moves.push({ type: 'fortify', at: i });
    for (const n of neighbors(i)) {
      const t = state.board[n];
      if (!t) expandTargets.add(n);
      else if (t.owner !== p && cell.str >= t.str) moves.push({ type: 'attack', from: i, to: n });
    }
  }
  for (const n of expandTargets) moves.push({ type: 'expand', to: n });
  if (moves.length === 0) moves.push({ type: 'pass' });
  return moves;
}

function sameMove(a, b) {
  return a.type === b.type && (a.at ?? null) === (b.at ?? null) && (a.from ?? null) === (b.from ?? null) && (a.to ?? null) === (b.to ?? null);
}

function describe(state, p, move) {
  const name = state.players[p].name;
  const at = (i) => { const [r, c] = rc(i); return `${String.fromCharCode(65 + c)}${r + 1}`; };
  switch (move.type) {
    case 'expand': return `${name} expands to ${at(move.to)}`;
    case 'fortify': return `${name} fortifies ${at(move.at)}`;
    case 'attack': return `${name} attacks ${at(move.to)} from ${at(move.from)}`;
    case 'pass': return `${name} passes`;
    default: return `${name}: ${move.type}`;
  }
}

function finish(state) {
  state.status = 'finished';
  state.scores = state.players.map((_, p) => scoreOf(state, p));
  let best = null;
  let draw = false;
  state.players.forEach((_, p) => {
    const s = state.scores[p];
    if (best === null) { best = p; return; }
    const b = state.scores[best];
    if (s.total > b.total || (s.total === b.total && s.strength > b.strength)) { best = p; draw = false; }
    else if (s.total === b.total && s.strength === b.strength) draw = true;
  });
  state.winner = draw ? null : best;
  state.log.push({ turn: state.turn, round: state.round, player: null, move: null, note: draw ? 'Match ends in a draw' : `${state.players[best].name} wins` });
}

function order(state) {
  const ids = state.players.map((pl) => pl.id);
  return state.round % 2 === 1 ? ids : ids.slice().reverse();
}

function advance(state) {
  // mark eliminated players
  for (const pl of state.players) pl.alive = cellsOf(state, pl.id).length > 0;
  const alive = state.players.filter((pl) => pl.alive);
  if (alive.length <= 1) return finish(state);
  // next living player in this round's order; if none left, start the next round
  const ord = order(state);
  const pos = ord.indexOf(state.current);
  let next = null;
  for (let k = pos + 1; k < ord.length; k++) if (state.players[ord[k]].alive) { next = ord[k]; break; }
  if (next === null) {
    if (state.round >= ROUNDS) return finish(state);
    state.round += 1;
    const ord2 = order(state);
    next = ord2.find((id) => state.players[id].alive);
  }
  state.current = next;
  state.turn += 1;
}

// Returns a NEW state. Throws Error with .code = 'ILLEGAL' on bad moves.
function applyMove(state, p, move) {
  if (state.status !== 'playing') { const e = new Error('match is not in progress'); e.code = 'ILLEGAL'; throw e; }
  if (state.current !== p) { const e = new Error(`not your turn (current player is ${state.current})`); e.code = 'ILLEGAL'; throw e; }
  const legal = legalMoves(state, p);
  const m = legal.find((l) => sameMove(l, move));
  if (!m) { const e = new Error('illegal move'); e.code = 'ILLEGAL'; e.legalMoves = legal; throw e; }
  const s = structuredClone(state);
  const b = s.board;
  let note = describe(s, p, m);
  if (m.type === 'expand') b[m.to] = { owner: p, str: 1 };
  else if (m.type === 'fortify') b[m.at].str += 1;
  else if (m.type === 'attack') {
    const victim = b[m.to].owner;
    const left = Math.max(1, b[m.from].str - b[m.to].str);
    b[m.to] = { owner: p, str: 1 };
    b[m.from].str = left;
    note += ` (captured from ${s.players[victim].name})`;
  }
  s.log.push({ turn: s.turn, round: s.round, player: p, move: m, note });
  advance(s);
  return s;
}

// Built-in bot: greedy on (my score - best rival score) after my move, minus the best immediate
// capture a rival could answer with (light 2-ply), plus small positional heuristics. Deterministic given rng.
function botMove(state, p, rng = Math.random) {
  const legal = legalMoves(state, p);
  if (legal.length === 1) return legal[0];
  const dist = (i) => { const [r, c] = rc(i); return Math.abs(r - 2.5) + Math.abs(c - 2.5); };
  const rivalsBest = (s) => Math.max(...s.players.filter((pl) => pl.id !== p && pl.alive).map((pl) => scoreOf(s, pl.id).total), 0);
  const myTotal = (s) => scoreOf(s, p).total;
  let best = [];
  let bestVal = -Infinity;
  for (const m of legal) {
    const s = applyMove(state, p, m);
    let v = myTotal(s) - rivalsBest(s);
    // what can the next player immediately take from me?
    if (s.status === 'playing') {
      const q = s.current;
      let worst = 0;
      for (const r of legalMoves(s, q)) {
        if (r.type !== 'attack' || s.board[r.to].owner !== p) continue;
        const s2 = applyMove(s, q, r);
        const loss = myTotal(s) - myTotal(s2);
        if (loss > worst) worst = loss;
      }
      v -= 0.8 * worst;
    }
    if (m.type === 'expand') v += 0.25 - 0.04 * dist(m.to);
    if (m.type === 'attack') v += 0.15;
    if (m.type === 'fortify') v -= 0.1;
    if (v > bestVal + 1e-9) { bestVal = v; best = [m]; }
    else if (Math.abs(v - bestVal) <= 1e-9) best.push(m);
  }
  return best[Math.floor(rng() * best.length)];
}

function publicState(state) {
  // strip nothing secret here (tokens live outside the game state), but add derived info for convenience
  return {
    ...state,
    scores: state.status === 'finished' ? state.scores : state.players.map((_, p) => scoreOf(state, p)),
  };
}

module.exports = { SIZE, CELLS, ROUNDS, MAX_STR, SPRINGS, cellValue, newState, legalMoves, applyMove, botMove, scoreOf, publicState, neighbors, rc, idx };

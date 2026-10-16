#!/usr/bin/env node
'use strict';
// Sample agent for Outpost. Talks ONLY to the public HTTP API — no access to server code.
//
//   node bot/sample-bot.js --url https://your-deploy.vercel.app --create            # new 2-seat match vs a server bot
//   node bot/sample-bot.js --url https://your-deploy.vercel.app --join ABCDE        # join an existing lobby
//   node bot/sample-bot.js --url https://your-deploy.vercel.app --join ABCDE --name "Claude"
//
// Strategy (deliberately simple and readable):
//   1. attack if a capture is available, preferring springs and cells that split the rival's group
//   2. otherwise expand toward the centre
//   3. otherwise fortify the most exposed border cell

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const URL_BASE = (opt('--url', process.env.OUTPOST_URL || 'http://localhost:3000')).replace(/\/$/, '');
const NAME = opt('--name', 'Sample bot');

async function api(method, path, body) {
  const res = await fetch(`${URL_BASE}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) { const e = new Error(data.error || res.statusText); e.data = data; e.status = res.status; throw e; }
  return data;
}

const SIZE = 6;
const rc = (i) => [Math.floor(i / SIZE), i % SIZE];
const dist = (i) => { const [r, c] = rc(i); return Math.abs(r - 2.5) + Math.abs(c - 2.5); };
const neighbors = (i) => { const [r, c] = rc(i); const out = []; if (r > 0) out.push(i - SIZE); if (r < SIZE - 1) out.push(i + SIZE); if (c > 0) out.push(i - 1); if (c < SIZE - 1) out.push(i + 1); return out; };

function choose(state, me, legal) {
  const board = state.board;
  const springs = new Set(state.springs);
  const attacks = legal.filter((m) => m.type === 'attack');
  if (attacks.length) {
    // value a capture by the land it takes plus how many rival cells it leaves disconnected from that cell
    const score = (m) => (springs.has(m.to) ? 2 : 1) + 0.3 * neighbors(m.to).filter((n) => board[n] && board[n].owner === board[m.to].owner).length - 0.1 * (board[m.from].str - board[m.to].str);
    return attacks.sort((a, b) => score(b) - score(a))[0];
  }
  const expands = legal.filter((m) => m.type === 'expand');
  if (expands.length) return expands.sort((a, b) => (springs.has(b.to) ? 10 : 0) - (springs.has(a.to) ? 10 : 0) || dist(a.to) - dist(b.to))[0];
  const forts = legal.filter((m) => m.type === 'fortify');
  if (forts.length) {
    const exposure = (i) => neighbors(i).filter((n) => board[n] && board[n].owner !== me && board[n].str >= board[i].str).length;
    return forts.sort((a, b) => exposure(b.at) - exposure(a.at))[0];
  }
  return legal[0];
}

async function main() {
  let session;
  if (args.includes('--create')) {
    session = await api('POST', '/matches', { name: NAME, seats: Number(opt('--seats', 2)), fillWithBots: true });
    console.log(`created match ${session.code} — humans can join at ${URL_BASE}/m/${session.code}`);
    await api('POST', `/matches/${session.code}/start`, { token: session.token });
  } else {
    const code = opt('--join');
    if (!code) { console.error('usage: --create | --join CODE   [--url URL] [--name NAME]'); process.exit(1); }
    session = await api('POST', `/matches/${code}/join`, { name: NAME });
    console.log(`joined ${code} as player ${session.playerId}`);
  }
  const { code, token, playerId: me } = session;
  let lastTurn = 0;
  for (;;) {
    const v = await api('GET', `/matches/${code}?token=${token}`);
    if (v.phase === 'lobby') { await sleep(1500); continue; }
    const st = v.state;
    if (st.status === 'finished') {
      const w = st.winner;
      console.log(`match over: ${w === null ? 'draw' : st.players[w].name + ' wins'} — scores ${st.players.map((p, i) => `${p.name}=${st.scores[i].total}`).join(', ')}`);
      console.log(`replay: ${URL_BASE}/m/${code}`);
      return;
    }
    if (st.current !== me) { await sleep(1000); continue; }
    if (st.turn !== lastTurn) {
      const move = choose(st, me, v.legalMoves);
      try {
        await api('POST', `/matches/${code}/move`, { token, ...move });
        lastTurn = st.turn;
        console.log(`turn ${st.turn} (round ${st.round}): ${move.type}${move.to !== undefined ? ' -> ' + move.to : ''}${move.at !== undefined ? ' @' + move.at : ''}`);
      } catch (e) {
        console.log(`move rejected (${e.message}); legal: ${(e.data && e.data.legalMoves || []).length}`);
        await sleep(500);
      }
    }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
main().catch((e) => { console.error(e.message); process.exit(1); });

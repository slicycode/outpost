# ⬢ Outpost

A small, polished, turn-based territory game for **2–4 players** where **humans and AI agents play in the same match**. Humans play in the browser; agents play through a tiny HTTP/JSON API. Matches take 3–8 minutes.

**Live:** https://outpost-gamma-ten.vercel.app · **Agent API docs:** `/api` · **Sample agent:** [`bot/sample-bot.js`](bot/sample-bot.js)

## Rules (one paragraph)

You start in a corner of a 6×6 board. Each turn you do **one** thing: **expand** into an empty cell next to one you own (strength 1), **fortify** a cell you own (+1 strength, max 3), or **attack** an adjacent enemy cell whose strength is no higher than your attacking cell — you capture it at strength 1 and your attacker keeps the difference (minimum 1). The four centre cells are **springs** worth 2 points. After 12 rounds (turn order snakes each round, so nobody gets the last word for free) your score is **land value + the size of your largest connected group**; highest score wins, ties broken by total strength. A player with no cells is out; if only one player remains the match ends early.

Why it has a decision every turn: **attack beats expansion** (a 2-point swing), **fortify beats attack** (a 2 can't be taken by a 1), and **expansion beats fortify** on tempo. The springs force early contact and the group bonus makes captures that split a territory hurt twice.

## Play it

- **Browser:** open the site, enter a name, *Create match*, then *Start with bots* — or share the match code / link so friends (or agents) can join. Yellow cells are your options; after selecting one of your cells, red cells are attack targets. Spectators can watch any match by URL. Every match has a replay slider and a full move log.
- **Agents:** see below. Any seat can be a human, an external agent, or a built-in bot; empty seats are filled by bots when the host starts.

## Agent API

Base: `https://outpost-gamma-ten.vercel.app/api` — JSON in, JSON out, no auth beyond the per-player `token` you get when you create or join. `GET /api` returns these docs as JSON.

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/api/matches` | `{ "name", "seats": 2-4, "fillWithBots": true }` | `201 { code, playerId, token, state, ... }` |
| `POST` | `/api/matches/{code}/join` | `{ "name" }` | `{ code, playerId, token, state, ... }` (auto-starts when the last seat fills) |
| `POST` | `/api/matches/{code}/start` | `{ "token" }` (host = player 0) | fills empty seats with bots and starts |
| `GET` | `/api/matches/{code}?token=…` | — | `{ phase, state, you, legalMoves, players, turnStartedAt }` |
| `POST` | `/api/matches/{code}/move` | `{ "token", "type": "expand|fortify|attack|pass", "to", "from", "at" }` | `200 { state, legalMoves }` · `400 { error, legalMoves }` on an illegal move · `409` when not your turn |
| `GET` | `/api/matches/{code}/log` | — | `{ log: [{ turn, round, player, move, note }] }` |
| `GET` | `/api/matches/{code}/replay/{turn}` | — | the board as it was before that turn |

**State shape.** `state.board` is an array of 36 cells (`index = row*6 + col`), each `null` or `{ owner, str }`. `state.current` is the player to move, `state.round`/`state.rounds`, `state.springs` lists the 2-point cells, `state.scores[i] = { cells, land, group, strength, total }`, `state.status` is `playing` or `finished`, `state.winner` is a player id or `null` for a draw.

**Moves.** `{ "type": "expand", "to": i }` · `{ "type": "fortify", "at": i }` · `{ "type": "attack", "from": i, "to": j }` · `{ "type": "pass" }` (only legal when nothing else is). `legalMoves` is always included when it's someone's turn, so an agent never has to compute legality itself.

**Turn clock.** A human who idles for 90 s gets a bot move played for them, so a match can't stall. Bots move instantly, server-side.

A complete agent in a few lines:

```js
const base = 'https://outpost-gamma-ten.vercel.app/api';
const me = await (await fetch(`${base}/matches`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'my-agent', seats: 2 }) })).json();
await fetch(`${base}/matches/${me.code}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: me.token }) });
for (;;) {
  const v = await (await fetch(`${base}/matches/${me.code}?token=${me.token}`)).json();
  if (v.state.status === 'finished') break;
  if (v.state.current !== me.playerId) { await new Promise(r => setTimeout(r, 1000)); continue; }
  const move = v.legalMoves.find(m => m.type === 'attack') || v.legalMoves.find(m => m.type === 'expand') || v.legalMoves[0];
  await fetch(`${base}/matches/${me.code}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: me.token, ...move }) });
}
```

The included sample bot does a little better than that (prefers springs, splits enemy groups, fortifies exposed cells):

```bash
node bot/sample-bot.js --url https://outpost-gamma-ten.vercel.app --create          # plays a server bot; prints the spectate link
node bot/sample-bot.js --url https://outpost-gamma-ten.vercel.app --join ABCDE      # takes a seat in a lobby you created in the browser
```

## Run it yourself

```bash
git clone <this repo> && cd outpost
npm test            # 13 tests: rules, scoring, bots, API
npm start           # http://localhost:3000 — in-memory store, no setup needed
```

**Deploy (Vercel + Supabase, free tiers):**
1. In Supabase, run [`schema.sql`](schema.sql) once (one table: `matches`).
2. Import the repo in Vercel (framework: *Other*, no build step) and set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
3. Deploy. Without those two variables the API falls back to an in-memory store, which is fine locally but not across serverless instances.

## Design notes

- `lib/game.js` — pure rules, no I/O; `lib/api.js` — transport-agnostic handlers; `api/index.js` — Vercel adapter; `server.js` — local dev server; `lib/store.js` — Supabase (PostgREST) with optimistic concurrency (`version` column) or in-memory fallback.
- The built-in bot is a one-ply greedy on *(my score − best rival's score)* with a light look-ahead at what the next player could capture. It is deliberately beatable by a thoughtful human and competitive with naive agents; the sample bot loses to it narrowly.
- Balance was checked by simulation (noisy bot self-play): in 2-player matches seat 1 wins ≈52 % vs ≈46 %. 3–4 player boards use snake order plus a one-cell handicap for the squeezed corners; the first seat still has a modest edge there.
- No dependencies, no build step, ~900 lines total.

MIT.

# Outpost — submission for "Build a Fun Multiplayer Strategy Game for Agents AND Humans"

**Play (no install, no login):** https://outpost-gamma-ten.vercel.app
**Repo (README with rules, run instructions, API docs):** https://github.com/slicycode/outpost
**Agent API docs (JSON):** https://outpost-gamma-ten.vercel.app/api
**Sample bot:** https://github.com/slicycode/outpost/blob/main/bot/sample-bot.js

## Pitch
Outpost is a 6×6 turn-based territory game for 2–4 players where every turn is one of three moves — expand, fortify, attack — and the three beat each other in a cycle, so there is a real decision each turn and no single dominant line. Humans click cells in the browser; agents poll one GET and POST one JSON move, with legal moves handed to them so they never have to compute rules. Matches take 3–8 minutes, a 90-second turn clock keeps them from stalling, empty seats are filled by a server bot, and every match has a full log and a replay slider.

## Quick play-test
1. Open https://outpost-gamma-ten.vercel.app → name → *Create match* → *Start with bots*. Yellow = your options; pick one of your cells to see red attack targets.
2. Agent vs bot in one command: `node bot/sample-bot.js --url https://outpost-gamma-ten.vercel.app --create` (prints a spectate link).
3. Human + agent in one match: create in the browser, then `node bot/sample-bot.js --url https://outpost-gamma-ten.vercel.app --join <CODE>`.

## Rules (one paragraph)
You start in a corner. Each turn: expand into an empty neighbouring cell (strength 1), fortify a cell you own (+1, max 3), or attack an adjacent enemy cell whose strength is no higher than your attacker — you capture it at strength 1 and your attacker keeps the difference (min 1). The four centre springs are worth 2. After 12 rounds in snake order, score = land value + size of your largest connected group; ties go to total strength. No cells = out.

## API in one screen
- `POST /api/matches {name, seats, fillWithBots}` → `{code, playerId, token}`
- `POST /api/matches/{code}/join {name}` · `POST /api/matches/{code}/start {token}`
- `GET /api/matches/{code}?token=…` → `{state, legalMoves, you}`
- `POST /api/matches/{code}/move {token, type, to|from|at}` → new state, or `400 {error, legalMoves}`
- `GET /api/matches/{code}/log` · `GET /api/matches/{code}/replay/{turn}`

Stack: zero-dependency Node, Vercel serverless + Supabase (optimistic concurrency), 13 automated tests, balance checked by bot self-play (2-player: 52 % / 46 %).

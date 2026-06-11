# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

PaperTrade is a Solana paper-trading bot: it simulates trades with a virtual USD balance against **live** DEX prices, runs an automated momentum strategy, and serves a local web dashboard tracking daily P&L against a 10%/day target. No real funds or wallets are involved — prices are real, money is not.

## Commands

- `npm run dev` — run the bot + dashboard (tsx, no build step). Dashboard at http://localhost:3000
- `npm run typecheck` — type-check without emitting
- `npm run build` / `npm start` — compile to `dist/` and run compiled output

There are no tests yet.

## Architecture

One Node process does everything; `src/index.ts` runs a 5-second tick loop that drives all components:

tick → `fetchPrices()` → `engine.rollDay()` → `strategy.tick()` (exits, then entries) → equity sampling → persistence → SSE broadcast → `tuner.maybeRun()`.

- `src/config.ts` — all tunables in one place: watchlist (token mints), strategy parameters, fees/slippage, intervals. Change behavior here first.
- `src/prices.ts` — live prices from Jupiter's free API (`lite-api.jup.ag/price/v3`, no key), DexScreener as fallback. Returns `Map<mint, usdPrice>`.
- `src/engine.ts` — `PaperEngine`: virtual cash, positions, fills (with simulated fee + slippage applied on both sides), realized P&L, daily-target baseline that rolls at midnight UTC.
- `src/strategy.ts` — `MomentumStrategy`: keeps an in-memory rolling price history per token (needs ~2 min of samples before it can signal — momentum reads are `null` until then). Entries require momentum over a 2-minute window plus a rising 30s confirmation; exits are take-profit / stop-loss / trailing stop / time stop, with a per-token cooldown after each exit.
- `src/store.ts` — JSON persistence to `data/state.json` (atomic write via tmp+rename). State survives restarts; delete the file or POST `/api/reset` to start over. Price history and cooldowns are NOT persisted — they rebuild after restart.
- `src/server.ts` — Express: serves `public/` (vanilla JS dashboard, no build step), `GET /api/state`, `GET /api/stream` (SSE pushed every tick), `POST /api/reset`, `GET|POST /api/settings` (tuner provider/model/keys, persisted to `.env`), `POST /api/tuner/run` (manual tuning run).
- `src/tuner.ts` — `StrategyTuner`: on a configurable interval (default 1h), sends the recent trading log (closed trades, exit reasons, hold durations, win rate, momentum readings) to an LLM and applies the returned parameter set to `CONFIG.strategy` in place, clamped to `STRATEGY_BOUNDS`. Without an API key the bot logs one warning and trades with static params. Tuned params and the adjustment log persist in `state.json` and are restored on boot; `/api/reset` reverts to `DEFAULT_STRATEGY`.
- `src/llm.ts` — provider layer for the tuner: Anthropic (official SDK, structured outputs via `messages.parse` + Zod), OpenAI and Gemini (plain `fetch`, JSON-schema responses). All providers' outputs are validated by the same Zod schema.
- `src/settings.ts` — runtime tuner settings (enabled/provider/model/interval) + API keys. Loads `.env` at import time (native `process.loadEnvFile`), writes changes back to `.env` (read-modify-write, preserves unmanaged lines). Keys are never returned to the UI — only a masked last-4 hint. Configurable from the dashboard ⚙ Settings modal; see `.env.example`.

The shared mutable state is `AppContext` (engine, strategy, latestPrices) — the tick loop writes it, HTTP handlers read it. `engine.state` is replaced wholesale on reset, so always access it via `ctx.engine.state`, never alias it.

## Conventions

- ESM throughout (`"type": "module"`): intra-project imports use `.js` extensions even in `.ts` files.
- Node 22+ assumed (global `fetch`, `AbortSignal.timeout`).
- All money values are USD numbers; percentages are in percent units (1.8 = 1.8%), not fractions.

import express, { type Response } from "express";
import { CONFIG, DEFAULT_STRATEGY } from "./config.js";
import { freshState, type PaperEngine } from "./engine.js";
import { settingsView, tunerSettings, updateSettings, type SettingsPatch } from "./settings.js";
import type { MomentumStrategy } from "./strategy.js";
import type { StrategyTuner } from "./tuner.js";
import type { PriceMap } from "./prices.js";
import { saveState } from "./store.js";

export interface AppContext {
  engine: PaperEngine;
  strategy: MomentumStrategy;
  tuner: StrategyTuner;
  latestPrices: PriceMap;
}

const sseClients = new Set<Response>();

export function snapshot(ctx: AppContext) {
  return {
    summary: ctx.engine.summary(ctx.latestPrices),
    positions: ctx.engine.state.positions.map((pos) => {
      const price = ctx.latestPrices.get(pos.mint) ?? pos.entryPrice;
      const value = pos.qty * price;
      return {
        ...pos,
        currentPrice: price,
        valueUsd: value,
        pnlUsd: value - pos.costUsd,
        pnlPct: ((value - pos.costUsd) / pos.costUsd) * 100,
      };
    }),
    trades: ctx.engine.state.trades.slice(-100).reverse(),
    watchlist: ctx.strategy.watchlistView(ctx.latestPrices),
    equityHistory: ctx.engine.state.equityHistory,
    dayStartEquity: ctx.engine.state.dayStartEquity,
    tuner: {
      enabled: tunerSettings.enabled,
      provider: tunerSettings.provider,
      model: tunerSettings.model,
      currentParams: { ...CONFIG.strategy },
      defaults: DEFAULT_STRATEGY,
      log: (ctx.engine.state.tunerLog ?? []).slice(-10).reverse(),
      lastRunAt: ctx.engine.state.tunerLastRunAt ?? null,
      intervalMs: tunerSettings.intervalMs,
    },
    now: Date.now(),
  };
}

export function broadcast(ctx: AppContext): void {
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(snapshot(ctx))}\n\n`;
  for (const res of sseClients) res.write(payload);
}

export function startServer(ctx: AppContext): void {
  const app = express();
  app.use(express.static("public"));
  app.use(express.json());

  app.get("/api/state", (_req, res) => {
    res.json(snapshot(ctx));
  });

  app.get("/api/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    res.write(`data: ${JSON.stringify(snapshot(ctx))}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
  });

  app.get("/api/settings", (_req, res) => {
    res.json(settingsView());
  });

  app.post("/api/settings", (req, res) => {
    try {
      updateSettings((req.body ?? {}) as SettingsPatch);
      broadcast(ctx);
      res.json(settingsView());
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post("/api/tuner/run", async (_req, res) => {
    const result = await ctx.tuner.forceRun(ctx, () => saveState(ctx.engine.state));
    if (result.ok) broadcast(ctx);
    res.status(result.ok ? 200 : 409).json(result);
  });

  app.post("/api/reset", async (_req, res) => {
    ctx.engine.state = freshState();
    Object.assign(CONFIG.strategy, DEFAULT_STRATEGY);
    await saveState(ctx.engine.state);
    broadcast(ctx);
    res.json({ ok: true });
  });

  app.listen(CONFIG.port, () => {
    console.log(`[server] dashboard at http://localhost:${CONFIG.port}`);
  });
}

import { CONFIG } from "./config.js";
import { PaperEngine } from "./engine.js";
import { fetchPrices, type PriceMap } from "./prices.js";
import { broadcast, startServer, type AppContext } from "./server.js";
import { loadState, saveState } from "./store.js";
import { MomentumStrategy } from "./strategy.js";
import { StrategyTuner } from "./tuner.js";

async function main() {
  const engine = new PaperEngine(await loadState());
  if (engine.state.strategyParams) {
    Object.assign(CONFIG.strategy, engine.state.strategyParams);
    console.log("[tuner] restored tuned strategy params from state");
  }
  const strategy = new MomentumStrategy();
  const tuner = new StrategyTuner();
  const ctx: AppContext = { engine, strategy, tuner, latestPrices: new Map() as PriceMap };

  startServer(ctx);

  let lastEquitySample = 0;
  let lastPersist = 0;
  let consecutiveFailures = 0;

  async function tick() {
    try {
      const prices = await fetchPrices();
      consecutiveFailures = 0;
      ctx.latestPrices = prices;

      engine.rollDay(prices);
      const trades = strategy.tick(engine, prices);
      for (const t of trades) {
        const pnl = t.pnlUsd !== undefined ? ` pnl $${t.pnlUsd.toFixed(2)} (${t.pnlPct!.toFixed(2)}%)` : "";
        console.log(`[trade] ${t.side.toUpperCase()} ${t.symbol} ${t.qty.toFixed(4)} @ $${t.price.toFixed(6)} — ${t.reason}${pnl}`);
      }

      const now = Date.now();
      if (now - lastEquitySample >= CONFIG.equitySampleIntervalMs) {
        engine.sampleEquity(prices);
        lastEquitySample = now;
      }
      if (trades.length > 0 || now - lastPersist >= CONFIG.persistIntervalMs) {
        await saveState(engine.state);
        lastPersist = now;
      }
      broadcast(ctx);
      tuner.maybeRun(ctx, () => saveState(engine.state));
    } catch (err) {
      consecutiveFailures++;
      console.error(`[tick] failed (${consecutiveFailures} in a row): ${(err as Error).message}`);
    }
  }

  await tick();
  setInterval(tick, CONFIG.pollIntervalMs);

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      console.log(`\n[main] ${sig} — saving state and exiting`);
      await saveState(engine.state);
      process.exit(0);
    });
  }
}

main();

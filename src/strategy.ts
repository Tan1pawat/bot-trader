import { CONFIG, WATCHLIST } from "./config.js";
import type { PaperEngine } from "./engine.js";
import type { PriceMap } from "./prices.js";
import type { PricePoint, Trade } from "./types.js";

const S = CONFIG.strategy;

/**
 * Momentum scalper: enter when a token has moved up over the momentum window
 * and is still rising over the confirmation window; exit on take-profit,
 * stop-loss, trailing stop, or time stop.
 */
export class MomentumStrategy {
  private history: Map<string, PricePoint[]> = new Map(); // mint -> recent prices
  private cooldownUntil: Map<string, number> = new Map(); // mint -> unix ms

  recordPrices(prices: PriceMap): void {
    const now = Date.now();
    const minT = now - CONFIG.priceHistoryMaxAgeSec * 1000;
    for (const [mint, p] of prices) {
      const arr = this.history.get(mint) ?? [];
      arr.push({ t: now, p });
      while (arr.length && arr[0].t < minT) arr.shift();
      this.history.set(mint, arr);
    }
  }

  /** % change from the sample closest to `seconds` ago, or null if history is too short. */
  momentum(mint: string, seconds: number): number | null {
    const arr = this.history.get(mint);
    if (!arr || arr.length < 2) return null;
    const targetT = Date.now() - seconds * 1000;
    // History must reach back far enough to cover the window (with one poll of tolerance).
    if (arr[0].t > targetT + CONFIG.pollIntervalMs) return null;
    let ref = arr[0];
    for (const pt of arr) {
      if (Math.abs(pt.t - targetT) < Math.abs(ref.t - targetT)) ref = pt;
    }
    const latest = arr[arr.length - 1];
    return ((latest.p - ref.p) / ref.p) * 100;
  }

  tick(engine: PaperEngine, prices: PriceMap): Trade[] {
    this.recordPrices(prices);
    const executed: Trade[] = [];
    executed.push(...this.runExits(engine, prices));
    executed.push(...this.runEntries(engine, prices));
    return executed;
  }

  private runExits(engine: PaperEngine, prices: PriceMap): Trade[] {
    const executed: Trade[] = [];
    for (const pos of [...engine.state.positions]) {
      const price = prices.get(pos.mint);
      if (!price) continue;
      if (price > pos.highPrice) pos.highPrice = price;

      const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
      const highPnlPct = ((pos.highPrice - pos.entryPrice) / pos.entryPrice) * 100;
      const fromHighPct = ((pos.highPrice - price) / pos.highPrice) * 100;
      const ageMin = (Date.now() - pos.entryTime) / 60_000;

      let reason: string | null = null;
      if (pnlPct >= S.takeProfitPct) reason = `take-profit +${pnlPct.toFixed(2)}%`;
      else if (pnlPct <= -S.stopLossPct) reason = `stop-loss ${pnlPct.toFixed(2)}%`;
      else if (highPnlPct >= S.trailingArmPct && fromHighPct >= S.trailingGivebackPct)
        reason = `trailing-stop +${pnlPct.toFixed(2)}% (high +${highPnlPct.toFixed(2)}%)`;
      else if (ageMin >= S.timeStopMin && pnlPct < S.timeStopMinPnlPct)
        reason = `time-stop ${pnlPct.toFixed(2)}% after ${ageMin.toFixed(0)}m`;

      if (reason) {
        executed.push(engine.sell(pos, price, reason));
        this.cooldownUntil.set(pos.mint, Date.now() + S.cooldownAfterExitMin * 60_000);
      }
    }
    return executed;
  }

  private runEntries(engine: PaperEngine, prices: PriceMap): Trade[] {
    const executed: Trade[] = [];
    if (engine.state.positions.length >= S.maxPositions) return executed;

    // Rank candidates by momentum so capital goes to the strongest mover first.
    const candidates = WATCHLIST
      .filter((t) => !engine.position(t.mint))
      .filter((t) => (this.cooldownUntil.get(t.mint) ?? 0) < Date.now())
      .map((t) => ({
        token: t,
        mom: this.momentum(t.mint, S.momentumWindowSec),
        confirm: this.momentum(t.mint, S.confirmWindowSec),
      }))
      .filter(
        (c): c is typeof c & { mom: number; confirm: number } =>
          c.mom !== null && c.confirm !== null && c.mom >= S.entryMomentumPct && c.confirm > 0,
      )
      .sort((a, b) => b.mom - a.mom);

    for (const c of candidates) {
      if (engine.state.positions.length >= S.maxPositions) break;
      const price = prices.get(c.token.mint);
      if (!price) continue;
      const usd = Math.min(engine.equity(prices) * S.positionSizePctOfEquity, engine.state.cashUsd);
      if (usd < 10) continue; // not enough cash for a meaningful position
      const trade = engine.buy(c.token, price, usd, `momentum +${c.mom.toFixed(2)}%/${S.momentumWindowSec}s`);
      if (trade) executed.push(trade);
    }
    return executed;
  }

  /** Momentum readings for the dashboard watchlist. */
  watchlistView(prices: PriceMap) {
    return WATCHLIST.map((t) => ({
      symbol: t.symbol,
      mint: t.mint,
      price: prices.get(t.mint) ?? null,
      momentumPct: this.momentum(t.mint, S.momentumWindowSec),
      cooldownUntil: this.cooldownUntil.get(t.mint) ?? null,
    }));
  }
}

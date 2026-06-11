import { CONFIG, STRATEGY_BOUNDS, type StrategyParams } from "./config.js";
import { callTuner, TunerOutput, type TunerOutputT } from "./llm.js";
import { hasTunerKey, PROVIDERS, tunerSettings } from "./settings.js";
import type { AppContext } from "./server.js";

const T = CONFIG.tuner;

const SYSTEM_PROMPT = `You are the strategy tuner for a Solana paper-trading momentum scalper.

How the bot works:
- Watches liquid Solana tokens with live DEX prices, polled every 5 seconds.
- Enters long when a token is up at least entryMomentumPct over momentumWindowSec AND still rising over confirmWindowSec. Capital goes to the strongest mover first, positionSizePctOfEquity of equity per trade, up to maxPositions concurrent positions.
- Exits are rule-based: take-profit at takeProfitPct, stop-loss at stopLossPct, trailing stop (armed at trailingArmPct, exits after trailingGivebackPct giveback from the high), and a time stop after timeStopMin minutes unless P&L >= timeStopMinPnlPct. After any exit the token has a cooldownAfterExitMin re-entry cooldown.
- Simulated costs: 0.10% fee + 0.05% slippage per side (~0.30% round trip), so takeProfitPct must comfortably clear that.
- Goal: +10% equity per day without large drawdowns.

Your job, once per hour:
- Read the performance report (closed trades since the last adjustment with P&L, exit reasons, and hold durations; aggregates; open positions; current per-token momentum) and return a complete new parameter set as JSON matching the requested schema.
- Diagnose from the exit reasons: many stop-losses means entries are too loose or stops too tight; many time-stops means momentum is fading (consider shorter holds or stricter entries); take-profits rarely hit means the target is too far for current volatility; trailing stops capturing most wins is healthy.
- Few or zero trades in the window can mean entries are too strict for a quiet market — but in a flat market, trading less is correct. Don't loosen entries just to generate activity.
- Prefer small, incremental changes (roughly 10-30% per parameter per hour). If performance is good or there is too little data to conclude anything, return the current values unchanged and say so in the rationale.
- Each parameter has a hard min/max given in the report; values outside the bounds will be clamped.
- All percentage parameters are in percent units (1.8 means 1.8%), except positionSizePctOfEquity which is a fraction (0.2 = 20%).`;

export interface TunerRunResult {
  ok: boolean;
  message: string;
}

export class StrategyTuner {
  private readonly bootTime = Date.now();
  private running = false;
  private nextAttemptAt = 0;
  private warnedNoKey = new Set<string>();

  /** Called every tick; fires an async tuning run when the interval has elapsed. */
  maybeRun(ctx: AppContext, onApplied: () => Promise<void>): void {
    if (!tunerSettings.enabled || this.running) return;
    const now = Date.now();
    if (now - this.bootTime < T.minUptimeMs || now < this.nextAttemptAt) return;
    const lastRun = ctx.engine.state.tunerLastRunAt ?? this.bootTime;
    if (now - lastRun < tunerSettings.intervalMs) return;

    if (!hasTunerKey()) {
      const keyEnv = PROVIDERS[tunerSettings.provider].keyEnv;
      if (!this.warnedNoKey.has(keyEnv)) {
        console.warn(`[tuner] ${keyEnv} not set — strategy tuning disabled (set it in .env or the dashboard settings)`);
        this.warnedNoKey.add(keyEnv);
      }
      return;
    }

    this.running = true;
    this.run(ctx, onApplied)
      .catch((err) => console.error(`[tuner] run failed: ${(err as Error).message}`))
      .finally(() => {
        this.running = false;
      });
  }

  /** Manual trigger from the dashboard; bypasses the interval and warm-up checks. */
  async forceRun(ctx: AppContext, onApplied: () => Promise<void>): Promise<TunerRunResult> {
    if (this.running) return { ok: false, message: "tuner is already running" };
    if (!hasTunerKey()) {
      return { ok: false, message: `${PROVIDERS[tunerSettings.provider].keyEnv} not set — add it in settings` };
    }
    this.running = true;
    try {
      return await this.run(ctx, onApplied);
    } finally {
      this.running = false;
    }
  }

  private async run(ctx: AppContext, onApplied: () => Promise<void>): Promise<TunerRunResult> {
    const { provider, model } = tunerSettings;
    const report = this.buildReport(ctx);

    let parsed: TunerOutputT;
    try {
      const raw = await callTuner(provider, model, SYSTEM_PROMPT, `Performance report:\n${JSON.stringify(report, null, 2)}`);
      const result = TunerOutput.safeParse(raw);
      if (!result.success) {
        this.nextAttemptAt = Date.now() + T.retryDelayMs;
        const message = `${provider}/${model} returned an unusable response — keeping current params`;
        console.warn(`[tuner] ${message}`);
        return { ok: false, message };
      }
      parsed = result.data;
    } catch (err) {
      this.nextAttemptAt = Date.now() + T.retryDelayMs;
      const message = (err as Error).message;
      console.error(`[tuner] ${message} — retrying in ${T.retryDelayMs / 60_000}m`);
      return { ok: false, message };
    }

    const before = { ...CONFIG.strategy };
    const after = this.clamp(parsed, before);
    Object.assign(CONFIG.strategy, after);

    const state = ctx.engine.state;
    state.strategyParams = { ...CONFIG.strategy };
    state.tunerLog ??= [];
    state.tunerLog.push({ time: Date.now(), before, after, rationale: parsed.rationale, model: `${provider}/${model}` });
    if (state.tunerLog.length > T.maxLogEntries) {
      state.tunerLog.splice(0, state.tunerLog.length - T.maxLogEntries);
    }
    state.tunerLastRunAt = Date.now();
    await onApplied();

    const changes = (Object.keys(STRATEGY_BOUNDS) as (keyof StrategyParams)[])
      .filter((k) => before[k] !== after[k])
      .map((k) => `${k}: ${before[k]} → ${after[k]}`);
    const message = `${changes.length ? changes.join(", ") : "no changes"} — ${parsed.rationale}`;
    console.log(`[tuner] ${message}`);
    return { ok: true, message };
  }

  /** Clamp the model's suggestions to STRATEGY_BOUNDS, falling back to current values for bad numbers. */
  private clamp(parsed: TunerOutputT, current: StrategyParams): StrategyParams {
    const out = { ...current };
    for (const key of Object.keys(STRATEGY_BOUNDS) as (keyof StrategyParams)[]) {
      const bounds = STRATEGY_BOUNDS[key];
      let v = parsed[key];
      if (!Number.isFinite(v)) continue;
      v = Math.min(bounds.max, Math.max(bounds.min, v));
      out[key] = bounds.integer ? Math.round(v) : v;
    }
    // Cross-parameter sanity: confirmation window inside the momentum window,
    // trailing giveback below its arm threshold.
    out.confirmWindowSec = Math.min(out.confirmWindowSec, out.momentumWindowSec);
    out.trailingGivebackPct = Math.min(out.trailingGivebackPct, out.trailingArmPct);
    return out;
  }

  private buildReport(ctx: AppContext) {
    const { engine, strategy, latestPrices } = ctx;
    const state = engine.state;
    const since = state.tunerLastRunAt ?? state.startedAt;
    const now = Date.now();

    const closed = state.trades.filter((t) => t.side === "sell" && t.time >= since);
    const entries = state.trades.filter((t) => t.side === "buy" && t.time >= since);
    const wins = closed.filter((t) => (t.pnlUsd ?? 0) > 0);

    return {
      windowStart: new Date(since).toISOString(),
      windowEnd: new Date(now).toISOString(),
      closedTrades: closed.map((t) => ({
        time: new Date(t.time).toISOString(),
        symbol: t.symbol,
        pnlUsd: round(t.pnlUsd ?? 0),
        pnlPct: round(t.pnlPct ?? 0),
        holdMin: t.holdMin != null ? round(t.holdMin, 1) : null,
        exitReason: t.reason,
      })),
      aggregates: {
        entriesOpened: entries.length,
        tradesClosed: closed.length,
        winRatePct: closed.length ? round((wins.length / closed.length) * 100, 1) : null,
        totalPnlUsd: round(closed.reduce((s, t) => s + (t.pnlUsd ?? 0), 0)),
        avgPnlPct: closed.length ? round(closed.reduce((s, t) => s + (t.pnlPct ?? 0), 0) / closed.length) : null,
      },
      portfolio: engine.summary(latestPrices),
      openPositions: state.positions.map((pos) => {
        const price = latestPrices.get(pos.mint) ?? pos.entryPrice;
        return {
          symbol: pos.symbol,
          pnlPct: round(((price * pos.qty - pos.costUsd) / pos.costUsd) * 100),
          ageMin: round((now - pos.entryTime) / 60_000, 1),
        };
      }),
      watchlistMomentum: strategy.watchlistView(latestPrices).map((w) => ({
        symbol: w.symbol,
        price: w.price,
        momentumPct: w.momentumPct != null ? round(w.momentumPct) : null,
      })),
      currentParams: { ...CONFIG.strategy },
      parameterBounds: STRATEGY_BOUNDS,
    };
  }
}

function round(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export interface TokenInfo {
  symbol: string;
  mint: string;
}

// Liquid Solana tokens with enough volatility for a momentum scalper.
export const WATCHLIST: TokenInfo[] = [
  { symbol: "SOL", mint: "So11111111111111111111111111111111111111112" },
  { symbol: "JUP", mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN" },
  { symbol: "WIF", mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" },
  { symbol: "BONK", mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
  { symbol: "JTO", mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL" },
  { symbol: "PYTH", mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3" },
  { symbol: "RAY", mint: "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R" },
];

export const CONFIG = {
  port: 3000,
  pollIntervalMs: 5_000,
  startingBalanceUsd: 10_000,
  dailyTargetPct: 10,

  // Simulated execution costs (per side)
  feeRate: 0.001, // 0.10% — DEX swap fee
  slippageRate: 0.0005, // 0.05% — price impact on fill

  strategy: {
    maxPositions: 4,
    positionSizePctOfEquity: 0.2, // 20% of equity per trade
    entryMomentumPct: 0.35, // require +0.35% move over the momentum window
    momentumWindowSec: 120,
    confirmWindowSec: 30, // short window must also be rising
    takeProfitPct: 1.1,
    stopLossPct: 0.9,
    trailingArmPct: 1.0, // start trailing once up 1.0%
    trailingGivebackPct: 0.5, // exit if price falls 0.5% from the high
    timeStopMin: 15, // exit stale positions
    timeStopMinPnlPct: 0.2, // ...unless they're at least this far up
    cooldownAfterExitMin: 3, // per-token re-entry cooldown
  },

  // LLM strategy tuner: reads recent trading performance and adjusts
  // CONFIG.strategy within STRATEGY_BOUNDS. These are the defaults — runtime
  // values (provider, model, interval, API keys) live in .env and are managed
  // via src/settings.ts and the dashboard settings UI.
  tuner: {
    enabled: true,
    intervalMs: 3_600_000, // adjust once per hour
    retryDelayMs: 300_000, // wait 5 min before retrying after an API failure
    minUptimeMs: 300_000, // let price history warm up before the first run
    model: "claude-opus-4-8",
    maxLogEntries: 20,
  },

  priceHistoryMaxAgeSec: 600,
  equitySampleIntervalMs: 15_000,
  equityHistoryMax: 5760, // 24h of 15s samples
  persistIntervalMs: 30_000,
  dataFile: "data/state.json",
};

export type StrategyParams = typeof CONFIG.strategy;

// Untuned defaults, used to restore params on portfolio reset.
export const DEFAULT_STRATEGY: StrategyParams = { ...CONFIG.strategy };

// Hard limits the tuner clamps Claude's suggestions to. momentumWindowSec max
// must stay <= priceHistoryMaxAgeSec or momentum() can never read the window.
export const STRATEGY_BOUNDS: Record<keyof StrategyParams, { min: number; max: number; integer?: boolean }> = {
  maxPositions: { min: 1, max: 8, integer: true },
  positionSizePctOfEquity: { min: 0.05, max: 0.5 },
  entryMomentumPct: { min: 0.1, max: 2 },
  momentumWindowSec: { min: 60, max: 600, integer: true },
  confirmWindowSec: { min: 10, max: 120, integer: true },
  takeProfitPct: { min: 0.5, max: 5 },
  stopLossPct: { min: 0.3, max: 3 },
  trailingArmPct: { min: 0.3, max: 3 },
  trailingGivebackPct: { min: 0.2, max: 2 },
  timeStopMin: { min: 5, max: 60, integer: true },
  timeStopMinPnlPct: { min: 0, max: 1 },
  cooldownAfterExitMin: { min: 1, max: 15, integer: true },
};

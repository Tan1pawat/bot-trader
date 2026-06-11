import type { StrategyParams } from "./config.js";

export interface PricePoint {
  t: number; // unix ms
  p: number; // USD price
}

export interface Position {
  symbol: string;
  mint: string;
  qty: number;
  entryPrice: number; // fill price incl. slippage
  entryTime: number;
  costUsd: number; // cash spent incl. fee
  highPrice: number; // high-water mark since entry, for trailing stop
}

export interface Trade {
  id: number;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  usd: number; // cash delta (negative for buys)
  feeUsd: number;
  time: number;
  reason: string;
  pnlUsd?: number; // realized, on sells
  pnlPct?: number;
  holdMin?: number; // position hold duration in minutes, on sells
}

export interface TunerAdjustment {
  time: number;
  before: StrategyParams;
  after: StrategyParams;
  rationale: string;
  model?: string; // "provider/model" that produced this adjustment
}

export interface EquitySample {
  t: number;
  equity: number;
}

export interface EngineState {
  cashUsd: number;
  positions: Position[];
  trades: Trade[];
  equityHistory: EquitySample[];
  dayKey: string; // YYYY-MM-DD the daily target is measured against
  dayStartEquity: number;
  nextTradeId: number;
  startedAt: number;
  strategyParams?: StrategyParams; // Claude-tuned params, re-applied on boot
  tunerLog?: TunerAdjustment[];
  tunerLastRunAt?: number;
}

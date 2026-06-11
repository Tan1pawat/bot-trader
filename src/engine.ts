import { CONFIG, WATCHLIST, type TokenInfo } from "./config.js";
import type { EngineState, Position, Trade } from "./types.js";
import type { PriceMap } from "./prices.js";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function freshState(): EngineState {
  return {
    cashUsd: CONFIG.startingBalanceUsd,
    positions: [],
    trades: [],
    equityHistory: [],
    dayKey: todayKey(),
    dayStartEquity: CONFIG.startingBalanceUsd,
    nextTradeId: 1,
    startedAt: Date.now(),
  };
}

export class PaperEngine {
  constructor(public state: EngineState) { }

  equity(prices: PriceMap): number {
    let total = this.state.cashUsd;
    for (const pos of this.state.positions) {
      const p = prices.get(pos.mint);
      total += pos.qty * (p ?? pos.entryPrice);
    }
    return total;
  }

  position(mint: string): Position | undefined {
    return this.state.positions.find((p) => p.mint === mint);
  }

  /** Roll the daily-target baseline when the calendar day changes. */
  rollDay(prices: PriceMap): void {
    const key = todayKey();
    if (key !== this.state.dayKey) {
      this.state.dayKey = key;
      this.state.dayStartEquity = this.equity(prices);
    }
  }

  buy(token: TokenInfo, marketPrice: number, usdToSpend: number, reason: string): Trade | null {
    if (usdToSpend <= 0 || usdToSpend > this.state.cashUsd) return null;
    const fillPrice = marketPrice * (1 + CONFIG.slippageRate);
    const feeUsd = usdToSpend * CONFIG.feeRate;
    const qty = (usdToSpend - feeUsd) / fillPrice;
    if (qty <= 0) return null;

    this.state.cashUsd -= usdToSpend;
    this.state.positions.push({
      symbol: token.symbol,
      mint: token.mint,
      qty,
      entryPrice: fillPrice,
      entryTime: Date.now(),
      costUsd: usdToSpend,
      highPrice: fillPrice,
    });

    const trade: Trade = {
      id: this.state.nextTradeId++,
      symbol: token.symbol,
      side: "buy",
      qty,
      price: fillPrice,
      usd: -usdToSpend,
      feeUsd,
      time: Date.now(),
      reason,
    };
    this.state.trades.push(trade);
    return trade;
  }

  sell(pos: Position, marketPrice: number, reason: string): Trade {
    const fillPrice = marketPrice * (1 - CONFIG.slippageRate);
    const gross = pos.qty * fillPrice;
    const feeUsd = gross * CONFIG.feeRate;
    const proceeds = gross - feeUsd;
    const pnlUsd = proceeds - pos.costUsd;

    this.state.cashUsd += proceeds;
    this.state.positions = this.state.positions.filter((p) => p !== pos);

    const trade: Trade = {
      id: this.state.nextTradeId++,
      symbol: pos.symbol,
      side: "sell",
      qty: pos.qty,
      price: fillPrice,
      usd: proceeds,
      feeUsd,
      time: Date.now(),
      reason,
      pnlUsd,
      pnlPct: (pnlUsd / pos.costUsd) * 100,
      holdMin: (Date.now() - pos.entryTime) / 60_000,
    };
    this.state.trades.push(trade);
    return trade;
  }

  sampleEquity(prices: PriceMap): void {
    this.state.equityHistory.push({ t: Date.now(), equity: this.equity(prices) });
    if (this.state.equityHistory.length > CONFIG.equityHistoryMax) {
      this.state.equityHistory.splice(0, this.state.equityHistory.length - CONFIG.equityHistoryMax);
    }
  }

  /** Stats for the dashboard. */
  summary(prices: PriceMap) {
    const equity = this.equity(prices);
    const dayPnlUsd = equity - this.state.dayStartEquity;
    const dayPnlPct = (dayPnlUsd / this.state.dayStartEquity) * 100;
    const sells = this.state.trades.filter((t) => t.side === "sell");
    const wins = sells.filter((t) => (t.pnlUsd ?? 0) > 0).length;
    return {
      equity,
      cashUsd: this.state.cashUsd,
      dayPnlUsd,
      dayPnlPct,
      dailyTargetPct: CONFIG.dailyTargetPct,
      totalPnlUsd: equity - CONFIG.startingBalanceUsd,
      totalPnlPct: ((equity - CONFIG.startingBalanceUsd) / CONFIG.startingBalanceUsd) * 100,
      tradesClosed: sells.length,
      winRate: sells.length ? (wins / sells.length) * 100 : null,
      startedAt: this.state.startedAt,
      watchlist: WATCHLIST.map((t) => t.symbol),
    };
  }
}

import { computeTradeStats } from "@luxalgo/broker-sdk/stats";
import type { BrokerPort } from "./brokers/port.js";

/*
  Per-account trade stats, computed by broker-sdk's stats engine (FIFO
  round-trip matching). Derived data only: recomputed on demand from fill
  history, never stored. Accounts whose port can't provide fills (or whose
  reads fail) simply have no stats, never fabricated ones.
*/

export type AccountTradeStats = {
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  realizedPnl: number;
};

export const tradeStatsForPort = async (port: BrokerPort): Promise<AccountTradeStats | null> => {
  if (!port.getTrades) return null;
  try {
    const stats = computeTradeStats(await port.getTrades());
    if (!stats || stats.closedTrades === 0) return null;
    return {
      closedTrades: stats.closedTrades,
      wins: stats.wins,
      losses: stats.losses,
      winRate: stats.winRate,
      realizedPnl: Number(stats.realizedPnl.toFixed(2)),
    };
  } catch {
    return null;
  }
};

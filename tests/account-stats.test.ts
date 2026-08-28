import { describe, expect, it } from "vitest";
import { createSimulator } from "../src/brokers/simulator.js";
import { tradeStatsForPort } from "../src/account-stats.js";

const sim = () => createSimulator({ id: "sim", startingEquity: 100_000, defaultFillPrice: 100, currency: "USD" });

describe("account trade stats (broker-sdk stats engine)", () => {
  it("returns null with no closed round trips", async () => {
    const port = sim();
    expect(await tradeStatsForPort(port)).toBeNull();

    await port.placeOrder({ symbol: "AAPL", side: "buy", type: "market", quantity: 10, timeInForce: "day", clientOrderId: "open", referencePrice: 100 });
    expect(await tradeStatsForPort(port)).toBeNull(); // open position only
  });

  it("computes realized PnL and win rate from simulator fills", async () => {
    const port = sim();
    await port.placeOrder({ symbol: "AAPL", side: "buy", type: "market", quantity: 10, timeInForce: "day", clientOrderId: "b1", referencePrice: 100 });
    await port.placeOrder({ symbol: "AAPL", side: "sell", type: "market", quantity: 10, timeInForce: "day", clientOrderId: "s1", referencePrice: 110 });
    await port.placeOrder({ symbol: "SPY", side: "buy", type: "market", quantity: 2, timeInForce: "day", clientOrderId: "b2", referencePrice: 500 });
    await port.placeOrder({ symbol: "SPY", side: "sell", type: "market", quantity: 2, timeInForce: "day", clientOrderId: "s2", referencePrice: 490 });

    const stats = await tradeStatsForPort(port);
    expect(stats).not.toBeNull();
    expect(stats!.closedTrades).toBe(2);
    expect(stats!.wins).toBe(1);
    expect(stats!.losses).toBe(1);
    expect(stats!.winRate).toBeCloseTo(0.5);
    expect(stats!.realizedPnl).toBeCloseTo(80); // +100 on AAPL, -20 on SPY
  });

  it("includes bracket-leg exits in the history", async () => {
    const port = sim();
    await port.placeOrder({
      symbol: "AAPL", side: "buy", type: "market", quantity: 10, timeInForce: "day",
      clientOrderId: "entry", referencePrice: 100, bracket: { takeProfitPrice: 110 },
    });
    port.updatePrice("AAPL", 111); // TP leg fills
    const stats = await tradeStatsForPort(port);
    expect(stats!.closedTrades).toBe(1);
    expect(stats!.realizedPnl).toBeCloseTo(111 * 10 - 100 * 10);
  });

  it("is null for ports without fill history", async () => {
    const bare = { ...sim() };
    delete (bare as { getTrades?: unknown }).getTrades;
    expect(await tradeStatsForPort(bare)).toBeNull();
  });
});

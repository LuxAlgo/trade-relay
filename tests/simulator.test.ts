import { describe, expect, it } from "vitest";
import { createSimulator } from "../src/brokers/simulator.js";

const sim = () => createSimulator({ id: "sim", startingEquity: 100_000, defaultFillPrice: 100, currency: "USD" });

describe("simulator", () => {
  it("fills market orders at the reference price and tracks cash, position, equity", async () => {
    const port = sim();
    const order = await port.placeOrder({
      symbol: "AAPL", side: "buy", type: "market", quantity: 10,
      timeInForce: "day", clientOrderId: "a", referencePrice: 150,
    });
    expect(order.status).toBe("filled");
    expect(order.filledAvgPrice).toBe(150);

    const positions = await port.getPositions();
    expect(positions).toEqual([{ symbol: "AAPL", quantity: 10, marketValue: 1500, averageEntryPrice: 150 }]);

    const equity = await port.getEquity();
    expect(equity.cash).toBe(98_500);
    expect(equity.equity).toBe(100_000);
  });

  it("is idempotent on clientOrderId", async () => {
    const port = sim();
    const first = await port.placeOrder({ symbol: "A", side: "buy", type: "market", quantity: 1, timeInForce: "day", clientOrderId: "same", referencePrice: 10 });
    const second = await port.placeOrder({ symbol: "A", side: "buy", type: "market", quantity: 1, timeInForce: "day", clientOrderId: "same", referencePrice: 10 });
    expect(second.id).toBe(first.id);
    expect((await port.getPositions())[0]?.quantity).toBe(1);
  });

  it("rests non-marketable limits and fills them on a price update", async () => {
    const port = sim();
    const order = await port.placeOrder({
      symbol: "AAPL", side: "buy", type: "limit", quantity: 5, limitPrice: 90,
      timeInForce: "gtc", clientOrderId: "l1", referencePrice: 100,
    });
    expect(order.status).toBe("open");

    expect(port.updatePrice("AAPL", 95)).toHaveLength(0);
    const fills = port.updatePrice("AAPL", 89);
    expect(fills).toHaveLength(1);
    expect(fills[0]?.status).toBe("filled");
    expect((await port.getPositions())[0]?.quantity).toBe(5);
  });

  it("triggers stops when the price crosses", async () => {
    const port = sim();
    await port.placeOrder({ symbol: "AAPL", side: "buy", type: "market", quantity: 10, timeInForce: "day", clientOrderId: "e", referencePrice: 100 });
    const stop = await port.placeOrder({
      symbol: "AAPL", side: "sell", type: "stop", quantity: 10, stopPrice: 95,
      timeInForce: "gtc", clientOrderId: "s1",
    });
    expect(stop.status).toBe("open");
    expect(port.updatePrice("AAPL", 96)).toHaveLength(0);
    const fills = port.updatePrice("AAPL", 94);
    expect(fills.map((f) => f.id)).toContain(stop.id);
    expect(await port.getPositions()).toEqual([]);
  });

  it("brackets: entry spawns TP/SL legs, one leg filling cancels the other", async () => {
    const port = sim();
    const entry = await port.placeOrder({
      symbol: "AAPL", side: "buy", type: "market", quantity: 10,
      timeInForce: "day", clientOrderId: "b1", referencePrice: 100,
      bracket: { takeProfitPrice: 110, stopLossPrice: 95 },
    });
    expect(entry.status).toBe("filled");
    expect(entry.legs).toHaveLength(2);

    const open = await port.listOrders({ status: "open" });
    expect(open).toHaveLength(2);

    const fills = port.updatePrice("AAPL", 111);
    expect(fills).toHaveLength(1);
    expect(fills[0]?.type).toBe("limit");
    expect(await port.getPositions()).toEqual([]);

    const remaining = await port.listOrders({ status: "open" });
    expect(remaining).toHaveLength(0); // the stop leg was canceled (OCO)
  });

  it("trailing stop ratchets with the high and triggers on the pullback", async () => {
    const port = sim();
    await port.placeOrder({ symbol: "AAPL", side: "buy", type: "market", quantity: 10, timeInForce: "day", clientOrderId: "e2", referencePrice: 100 });
    const trail = await port.placeOrder({
      symbol: "AAPL", side: "sell", type: "trailing_stop", quantity: 10,
      trailAmount: 5, timeInForce: "gtc", clientOrderId: "t1",
    });
    expect(trail.status).toBe("open");

    expect(port.updatePrice("AAPL", 110)).toHaveLength(0); // watermark 110, stop 105
    expect(port.updatePrice("AAPL", 107)).toHaveLength(0); // above stop, holds
    const fills = port.updatePrice("AAPL", 104.9);
    expect(fills).toHaveLength(1);
    expect(await port.getPositions()).toEqual([]);
  });

  it("derives quantity from notional on market orders", async () => {
    const port = sim();
    const order = await port.placeOrder({ symbol: "BTCUSD", side: "buy", type: "market", notional: 500, timeInForce: "day", clientOrderId: "n1", referencePrice: 50_000 });
    expect(order.status).toBe("filled");
    expect(order.quantity).toBeCloseTo(0.01);
  });

  it("handles shorts and crossing through flat", async () => {
    const port = sim();
    await port.placeOrder({ symbol: "AAPL", side: "sell", type: "market", quantity: 5, timeInForce: "day", clientOrderId: "sh", referencePrice: 100 });
    expect((await port.getPositions())[0]?.quantity).toBe(-5);

    await port.placeOrder({ symbol: "AAPL", side: "buy", type: "market", quantity: 8, timeInForce: "day", clientOrderId: "fl", referencePrice: 90 });
    const [position] = await port.getPositions();
    expect(position?.quantity).toBe(3);
    expect(position?.averageEntryPrice).toBe(90);
  });

  it("cancelAllOrders cancels only open orders", async () => {
    const port = sim();
    await port.placeOrder({ symbol: "A", side: "buy", type: "limit", quantity: 1, limitPrice: 1, timeInForce: "gtc", clientOrderId: "c1", referencePrice: 10 });
    await port.placeOrder({ symbol: "A", side: "buy", type: "market", quantity: 1, timeInForce: "day", clientOrderId: "c2", referencePrice: 10 });
    expect(await port.cancelAllOrders()).toBe(1);
  });

  it("validates malformed requests", async () => {
    const port = sim();
    await expect(port.placeOrder({ symbol: "A", side: "buy", type: "limit", quantity: 1, timeInForce: "day", clientOrderId: "v1" })).rejects.toThrow(/limitPrice/);
    await expect(port.placeOrder({ symbol: "A", side: "buy", type: "market", timeInForce: "day", clientOrderId: "v2" })).rejects.toThrow(/exactly one/);
    await expect(port.placeOrder({ symbol: "A", side: "buy", type: "limit", notional: 5, limitPrice: 1, timeInForce: "day", clientOrderId: "v3" })).rejects.toThrow(/market/);
  });
});

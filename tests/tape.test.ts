import { describe, expect, it } from "vitest";
import { matchRoundTrips } from "@luxalgo/broker-sdk/stats";
import { createSimulator } from "../src/brokers/simulator.js";
import { createMemoryStorage } from "../src/storage/memory.js";
import { barsForPort, buildTape, collectFills, fillsFromRecords, pairFills, realizedPnl, summarizeSymbols } from "../src/tape.js";
import type { PortOrder, SignalRecord } from "../src/types.js";

let orderSeq = 0;
const order = (overrides: Partial<PortOrder> & Pick<PortOrder, "symbol" | "side">): PortOrder => ({
  id: `o-${++orderSeq}`,
  type: "market",
  status: "filled",
  quantity: 1,
  filledQuantity: 1,
  filledAvgPrice: 100,
  ...overrides,
});

let recordSeq = 0;
const record = (at: string, overrides: Partial<SignalRecord> = {}): SignalRecord => ({
  id: `sig-${++recordSeq}`,
  endpointId: "tv",
  receivedAt: at,
  rawBody: "{}",
  status: "executed",
  accountId: "sim",
  ...overrides,
});

describe("fillsFromRecords", () => {
  it("keeps filled orders only, tags triggered ones, and sorts by time", () => {
    const records = [
      record("2026-09-02T14:00:00.000Z", { order: order({ symbol: "AAPL", side: "buy", filledQuantity: 2, filledAvgPrice: 100 }) }),
      record("2026-09-01T14:00:00.000Z", { order: order({ symbol: "AAPL", side: "buy", status: "open", filledQuantity: 0 }) }),
      record("2026-09-03T14:00:00.000Z", {
        status: "noop",
        orders: [order({ symbol: "AAPL", side: "sell", filledQuantity: 2, filledAvgPrice: 110 }), order({ symbol: "AAPL", side: "sell", status: "canceled", filledQuantity: 0 })],
      }),
    ];
    const fills = fillsFromRecords(records);
    expect(fills.map((fill) => [fill.side, fill.price, fill.triggered])).toEqual([
      ["buy", 100, false],
      ["sell", 110, true],
    ]);
    expect(fills[0]!.signalId).toBe(records[0]!.id);
    expect(fills[1]!.at).toBe("2026-09-03T14:00:00.000Z");
  });

  it("puts a story's triggered fills before the order it placed itself", () => {
    const fills = fillsFromRecords([
      record("2026-09-02T14:00:00.000Z", {
        order: order({ id: "z-placed", symbol: "AAPL", side: "buy", filledQuantity: 2, filledAvgPrice: 196 }),
        orders: [order({ id: "a-leg", symbol: "AAPL", side: "sell", filledQuantity: 6, filledAvgPrice: 196 })],
      }),
    ]);
    expect(fills.map((fill) => fill.orderId)).toEqual(["a-leg", "z-placed"]);
  });

  it("counts an idempotent re-send's shared broker order once", () => {
    const shared = order({ symbol: "SPY", side: "buy" });
    const fills = fillsFromRecords([
      record("2026-09-02T14:00:00.000Z", { order: shared }),
      record("2026-09-02T14:00:05.000Z", { order: { ...shared } }),
    ]);
    expect(fills).toHaveLength(1);
  });
});

describe("pairFills (FIFO, the stats engine's rules)", () => {
  const fills = fillsFromRecords([
    record("2026-09-01T14:00:00.000Z", { order: order({ symbol: "AAPL", side: "buy", filledQuantity: 3, filledAvgPrice: 100 }) }),
    record("2026-09-01T15:00:00.000Z", { order: order({ symbol: "AAPL", side: "buy", filledQuantity: 2, filledAvgPrice: 104 }) }),
    record("2026-09-02T14:00:00.000Z", { order: order({ symbol: "AAPL", side: "sell", filledQuantity: 4, filledAvgPrice: 110 }) }),
    record("2026-09-02T15:00:00.000Z", { order: order({ symbol: "AAPL", side: "sell", filledQuantity: 5, filledAvgPrice: 90 }) }),
  ]);

  it("matches exits against the oldest entries and splits across lots", () => {
    const pairs = pairFills(fills);
    expect(pairs.map((pair) => [pair.quantity, pair.entryPrice, pair.exitPrice, pair.pnl])).toEqual([
      [3, 100, 110, 30],
      [1, 104, 110, 6],
      [1, 104, 90, -14],
    ]);
    expect(pairs[0]!.entrySignalId).toBe(fills[0]!.signalId);
    expect(pairs[0]!.exitSignalId).toBe(fills[2]!.signalId);
    // The 4 unmatched units of the last sell are not guessed at.
    expect(pairs.reduce((sum, pair) => sum + pair.quantity, 0)).toBe(5);
  });

  it("agrees with broker-sdk's matchRoundTrips on realized P&L", () => {
    const pairs = pairFills(fills);
    const sdk = matchRoundTrips(fills.map((fill) => ({ symbol: fill.symbol, side: fill.side, quantity: fill.quantity, price: fill.price, executedAt: fill.at })));
    expect(pairs.reduce((sum, pair) => sum + pair.pnl, 0)).toBeCloseTo(sdk.reduce((sum, trip) => sum + trip.pnl, 0));
    expect(realizedPnl(fills)).toBeCloseTo(22);
  });

  it("never pairs across accounts", () => {
    const split = fillsFromRecords([
      record("2026-09-01T14:00:00.000Z", { accountId: "a", order: order({ symbol: "AAPL", side: "buy" }) }),
      record("2026-09-01T15:00:00.000Z", { accountId: "b", order: order({ symbol: "AAPL", side: "sell", filledAvgPrice: 120 }) }),
    ]);
    expect(pairFills(split)).toEqual([]);
  });
});

describe("summarizeSymbols", () => {
  it("lists symbols with their sessions, most recent first", () => {
    const fills = fillsFromRecords([
      record("2026-09-01T14:00:00.000Z", { order: order({ symbol: "AAPL", side: "buy" }) }),
      record("2026-09-01T16:00:00.000Z", { order: order({ symbol: "AAPL", side: "sell" }) }),
      record("2026-09-03T14:00:00.000Z", { order: order({ symbol: "AAPL", side: "buy" }) }),
      record("2026-09-02T14:00:00.000Z", { order: order({ symbol: "SPY", side: "buy" }) }),
    ]);
    const summary = summarizeSymbols(fills);
    expect(summary.map((entry) => entry.symbol)).toEqual(["AAPL", "SPY"]);
    expect(summary[0]).toMatchObject({ fills: 3, sessions: ["2026-09-01", "2026-09-03"], accounts: ["sim"] });
  });
});

describe("bars", () => {
  it("no port can provide bars today, and none are invented", async () => {
    const sim = createSimulator({ id: "sim", startingEquity: 100_000, defaultFillPrice: 100, currency: "USD" });
    expect(await barsForPort(sim, "AAPL", {})).toEqual({ bars: null, source: "none", timeframe: null });
    expect(await barsForPort(undefined, "AAPL", {})).toEqual({ bars: null, source: "none", timeframe: null });
  });
});

describe("buildTape over storage", () => {
  it("pages through the flight recorder and keeps pairs whose entry sits before the window", async () => {
    const storage = createMemoryStorage();
    const entry = record("2026-09-01T14:00:00.000Z", { order: order({ symbol: "AAPL", side: "buy", filledQuantity: 2, filledAvgPrice: 100 }) });
    const exit = record("2026-09-03T14:00:00.000Z", { order: order({ symbol: "AAPL", side: "sell", filledQuantity: 2, filledAvgPrice: 105 }) });
    storage.insertSignal(entry);
    storage.insertSignal(exit);
    storage.insertSignal(record("2026-09-03T15:00:00.000Z", { status: "rejected" }));
    for (let i = 0; i < 5; i += 1) {
      storage.insertSignal(record(`2026-08-2${i}T14:00:00.000Z`, { order: order({ symbol: "SPY", side: "buy" }) }));
    }

    const fills = collectFills(storage, 3);
    expect(fills).toHaveLength(7);

    const tape = await buildTape("AAPL", fills, { from: "2026-09-03T00:00:00.000Z" }, new Map());
    expect(tape.fills.map((fill) => fill.signalId)).toEqual([exit.id]);
    expect(tape.pairs).toHaveLength(1);
    expect(tape.pairs[0]).toMatchObject({ entrySignalId: entry.id, exitSignalId: exit.id, pnl: 10 });
    expect(tape.bars).toBeNull();
    expect(tape.barsSource).toBe("none");
    expect(tape.from).toBe("2026-09-03T00:00:00.000Z");
    expect(tape.to).toBeNull();
  });
});

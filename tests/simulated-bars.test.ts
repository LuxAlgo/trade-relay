import { describe, expect, it } from "vitest";
import { simulatedBars, type PriceAnchor } from "../src/brokers/simulated-bars.js";
import { createSimulator } from "../src/brokers/simulator.js";

const MINUTE = 60_000;
const T0 = Date.UTC(2026, 8, 3, 14, 30, 12); // 14:30:12Z — not on a minute boundary on purpose

const anchors: PriceAnchor[] = [
  { time: T0, price: 189.2 },
  { time: T0 + 4 * MINUTE + 20_000, price: 190.1 }, // 14:34:32Z
  { time: T0 + 4 * MINUTE + 40_000, price: 190.4 }, // 14:34:52Z — two anchors in one minute
  { time: T0 + 11 * MINUTE, price: 193.4 },
  { time: T0 + 12 * MINUTE + 5_000, price: 191.0 },
];

const bucket = (time: number) => Math.floor(time / MINUTE) * MINUTE;

describe("simulated bars (the simulator's own price history at 1m)", () => {
  const bars = simulatedBars("AAPL", anchors, { timeframe: "1m" });

  it("is deterministic for the same history", () => {
    expect(simulatedBars("AAPL", anchors, { timeframe: "1m" })).toEqual(bars);
    expect(simulatedBars("AAPL", [...anchors].reverse(), { timeframe: "1m" })).toEqual(bars);
    // A different symbol or history seeds a different path.
    expect(simulatedBars("SPY", anchors, { timeframe: "1m" })).not.toEqual(bars);
  });

  it("walks minute by minute, monotone, from the first anchor to a few bars past the last", () => {
    expect(bars[0]!.time).toBe(bucket(T0));
    for (let index = 1; index < bars.length; index += 1) expect(bars[index]!.time - bars[index - 1]!.time).toBe(MINUTE);
    const last = anchors[anchors.length - 1]!.time;
    expect(bars[bars.length - 1]!.time).toBeGreaterThan(bucket(last));
    expect(bars[bars.length - 1]!.time - bucket(last)).toBeLessThanOrEqual(3 * MINUTE);
  });

  it("hits every anchor: the bar containing it spans its price and closes on the minute's last anchor", () => {
    for (const anchor of anchors) {
      const bar = bars.find((candidate) => candidate.time === bucket(anchor.time))!;
      expect(bar.low).toBeLessThanOrEqual(anchor.price);
      expect(bar.high).toBeGreaterThanOrEqual(anchor.price);
    }
    expect(bars.find((bar) => bar.time === bucket(T0))!.open).toBe(189.2);
    expect(bars.find((bar) => bar.time === bucket(T0 + 4 * MINUTE + 20_000))!.close).toBe(190.4);
    expect(bars.find((bar) => bar.time === bucket(T0 + 11 * MINUTE))!.close).toBe(193.4);
  });

  it("keeps OHLC sane and continuous", () => {
    for (let index = 0; index < bars.length; index += 1) {
      const bar = bars[index]!;
      expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close));
      expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close));
      if (index > 0) expect(bar.open).toBeCloseTo(bars[index - 1]!.close, 6);
    }
  });

  it("stays near the path between anchors instead of wandering", () => {
    const between = bars.filter((bar) => bar.time > bucket(T0) && bar.time < bucket(T0 + 4 * MINUTE));
    expect(between).toHaveLength(3);
    for (const bar of between) {
      expect(bar.close).toBeGreaterThan(187);
      expect(bar.close).toBeLessThan(192.5);
    }
  });

  it("trims to the requested window without changing the walk", () => {
    const from = bucket(T0) + 5 * MINUTE;
    const to = bucket(T0) + 11 * MINUTE;
    const window = simulatedBars("AAPL", anchors, { timeframe: "1m", from, to });
    expect(window[0]!.time).toBe(from);
    expect(window[window.length - 1]!.time).toBe(to);
    expect(window).toEqual(bars.filter((bar) => bar.time >= from && bar.time <= to));
  });

  it("draws nothing for a symbol it never priced", () => {
    expect(simulatedBars("NOPE", [], { timeframe: "1m" })).toEqual([]);
  });
});

describe("simulator.getBars", () => {
  it("covers the fills and the price updates the simulator saw, in order", async () => {
    let clock = T0;
    const port = createSimulator({ id: "sim", startingEquity: 100_000, defaultFillPrice: 100, currency: "USD", now: () => new Date(clock) });
    await port.placeOrder({ symbol: "AAPL", side: "buy", type: "market", quantity: 10, timeInForce: "day", clientOrderId: "a", referencePrice: 189.2 });
    clock += 3 * MINUTE;
    port.updatePrice("AAPL", 190.5); // a price the simulator saw without a fill
    clock += 5 * MINUTE;
    await port.placeOrder({ symbol: "AAPL", side: "sell", type: "market", quantity: 10, timeInForce: "day", clientOrderId: "b", referencePrice: 193.4 });

    const bars = await port.getBars!("AAPL", { timeframe: "1m" });
    expect(bars[0]!.time).toBe(bucket(T0));
    expect(bars[0]!.open).toBe(189.2);
    const update = bars.find((bar) => bar.time === bucket(T0 + 3 * MINUTE))!;
    expect(update.close).toBe(190.5);
    const exit = bars.find((bar) => bar.time === bucket(T0 + 8 * MINUTE))!;
    expect(exit.close).toBe(193.4);
    expect(bars[bars.length - 1]!.time).toBeGreaterThan(bucket(T0 + 8 * MINUTE));
    expect(await port.getBars!("SPY", { timeframe: "1m" })).toEqual([]);
  });

  it("anchors a fill at the default price when the signal carried none", async () => {
    const port = createSimulator({ id: "sim", startingEquity: 100_000, defaultFillPrice: 100, currency: "USD", now: () => new Date(T0) });
    await port.placeOrder({ symbol: "SPY", side: "buy", type: "market", quantity: 1, timeInForce: "day", clientOrderId: "c" });
    const bars = await port.getBars!("SPY", { timeframe: "1m" });
    expect(bars[0]).toMatchObject({ time: bucket(T0), open: 100, close: 100 });
  });
});

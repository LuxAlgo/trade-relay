import { describe, expect, it, vi } from "vitest";
import type { PortBar } from "../src/types.js";

/*
  The SDK port's bar seam: broker-sdk 0.5.0 puts fetchBars on every read
  connection and answers UnsupportedCapabilityError where a broker has no
  market-data endpoints, so the port gates on supportsBars(broker) and then
  delegates to the connection's fetchBars. The real module is wrapped so
  no network is touched: connections get a recording fetchBars, and one
  broker is declared unsupported to prove the gate.
*/

const FAKE_BARS: PortBar[] = [
  { time: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
  { time: 1_700_000_060_000, open: 1.5, high: 2.5, low: 1, close: 2 },
];

const calls: unknown[] = [];

vi.mock("@luxalgo/broker-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@luxalgo/broker-sdk")>();
  return {
    ...actual,
    // Tradier is declared bar-less here to exercise the gate; Alpaca keeps the SDK's answer.
    supportsBars: (broker: string) => (broker === "tradier" ? false : actual.supportsBars(broker as never)),
    connect: (options: Parameters<typeof actual.connect>[0]) =>
      Object.assign(actual.connect(options), {
        fetchBars: async (symbol: string, request: unknown) => {
          calls.push([options.broker, symbol, request]);
          return FAKE_BARS;
        },
      }),
  };
});

const { createSdkPort } = await import("../src/brokers/sdk-port.js");

describe("sdk port bars seam", () => {
  it("exposes getBars when the SDK says the broker supports bars, and delegates to fetchBars", async () => {
    const alpaca = createSdkPort({ id: "p", broker: "alpaca", credentials: { apiKey: "PKTESTKEY", apiSecret: "secret" } });
    expect(typeof alpaca.getBars).toBe("function");
    const bars = await alpaca.getBars!("AAPL", { timeframe: "1m", from: 1, to: 2 });
    expect(bars).toEqual(FAKE_BARS);
    expect(calls).toEqual([["alpaca", "AAPL", { timeframe: "1m", from: 1, to: 2 }]]);
  });

  it("leaves getBars undefined when supportsBars says no, even though the connection has the method", () => {
    const tradier = createSdkPort({ id: "t", broker: "tradier", credentials: { accessToken: "sandbox-token" } });
    expect(tradier.getBars).toBeUndefined();
  });
});

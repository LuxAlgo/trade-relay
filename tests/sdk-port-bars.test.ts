import { describe, expect, it, vi } from "vitest";
import type { PortBar } from "../src/types.js";

/*
  The SDK port's bar seam is a runtime feature test against broker-sdk's
  connection objects. The installed SDK has no fetchBars yet, so the real
  module is wrapped: one variant with the method the upcoming release adds,
  one without, and the port must follow whichever it finds.
*/

const FAKE_BARS: PortBar[] = [
  { time: 1_700_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
  { time: 1_700_000_060_000, open: 1.5, high: 2.5, low: 1, close: 2 },
];

const calls: unknown[] = [];

vi.mock("@luxalgo/broker-sdk/orders", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@luxalgo/broker-sdk/orders")>();
  return {
    ...actual,
    connectTrading: (options: Parameters<typeof actual.connectTrading>[0]) => {
      const connection = actual.connectTrading(options);
      // Tradier gets the capability in this test; Alpaca is left without it.
      if (options.broker === "tradier") {
        return Object.assign(connection, {
          fetchBars: async (symbol: string, request: unknown) => {
            calls.push([symbol, request]);
            return FAKE_BARS;
          },
        });
      }
      return connection;
    },
  };
});

const { createSdkPort } = await import("../src/brokers/sdk-port.js");

describe("sdk port bars seam", () => {
  it("exposes getBars only when the SDK connection has fetchBars", async () => {
    const withBars = createSdkPort({ id: "t", broker: "tradier", credentials: { accessToken: "sandbox-token" } });
    expect(typeof withBars.getBars).toBe("function");
    const bars = await withBars.getBars!("AAPL", { timeframe: "1m", from: 1, to: 2 });
    expect(bars).toEqual(FAKE_BARS);
    expect(calls).toEqual([["AAPL", { timeframe: "1m", from: 1, to: 2 }]]);

    const without = createSdkPort({ id: "p", broker: "alpaca", credentials: { apiKey: "PKTESTKEY", apiSecret: "secret" } });
    expect(without.getBars).toBeUndefined();
  });
});

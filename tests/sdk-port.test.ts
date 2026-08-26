import { describe, expect, it } from "vitest";
import { LIVE_TRADING_ACKNOWLEDGEMENT, LiveTradingBlockedError } from "@luxalgo/broker-sdk/orders";
import { createSdkPort } from "../src/brokers/sdk-port.js";
import { UnsupportedOrderError } from "../src/brokers/port.js";

const paper = () =>
  createSdkPort({ id: "paper", broker: "alpaca", credentials: { apiKey: "PKTESTKEY", apiSecret: "secret" } });

describe("sdk port (no network — everything here is refused before any call)", () => {
  it("alpaca paper keys connect as environment paper", () => {
    expect(paper().environment).toBe("paper");
  });

  it("alpaca live keys are blocked without the exact acknowledgement sentence", () => {
    expect(() =>
      createSdkPort({ id: "live", broker: "alpaca", credentials: { apiKey: "AKLIVEKEY", apiSecret: "secret" } }),
    ).toThrow(LiveTradingBlockedError);
    expect(() =>
      createSdkPort({
        id: "live",
        broker: "alpaca",
        credentials: { apiKey: "AKLIVEKEY", apiSecret: "secret" },
        acknowledgeLiveTrading: "yes I'm sure",
      }),
    ).toThrow(LiveTradingBlockedError);

    const acknowledged = createSdkPort({
      id: "live",
      broker: "alpaca",
      credentials: { apiKey: "AKLIVEKEY", apiSecret: "secret" },
      acknowledgeLiveTrading: LIVE_TRADING_ACKNOWLEDGEMENT,
    });
    expect(acknowledged.environment).toBe("live");
  });

  it("tradier connects sandbox-only", () => {
    const port = createSdkPort({ id: "t", broker: "tradier", credentials: { accessToken: "sandbox-token" } });
    expect(port.environment).toBe("sandbox");
    expect(port.capabilities().notionalMarket).toBe(false);
  });

  it("refuses order types the SDK cannot express yet, pointing upstream", async () => {
    const base = { symbol: "AAPL", side: "buy" as const, quantity: 1, timeInForce: "day" as const, clientOrderId: "x" };
    await expect(paper().placeOrder({ ...base, type: "stop", stopPrice: 90 })).rejects.toThrow(UnsupportedOrderError);
    await expect(paper().placeOrder({ ...base, type: "trailing_stop", trailAmount: 5 })).rejects.toThrow(UnsupportedOrderError);
    await expect(
      paper().placeOrder({ ...base, type: "market", bracket: { takeProfitPrice: 120 } }),
    ).rejects.toThrow(/bracket/);
  });

  it("refuses notional sizing where the broker lacks it", async () => {
    const port = createSdkPort({ id: "t", broker: "tradier", credentials: { accessToken: "sandbox-token" } });
    await expect(
      port.placeOrder({ symbol: "AAPL", side: "buy", type: "market", notional: 100, timeInForce: "day", clientOrderId: "n" }),
    ).rejects.toThrow(UnsupportedOrderError);
  });

  it("tradier reads fail closed with a message that names the upstream gap", async () => {
    const port = createSdkPort({ id: "t", broker: "tradier", credentials: { accessToken: "sandbox-token" } });
    await expect(port.getEquity()).rejects.toThrow(/sandbox positions\/equity are unavailable/);
    await expect(port.getPositions()).rejects.toThrow(/fail closed/);
  });
});

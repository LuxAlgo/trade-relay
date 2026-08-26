import { describe, expect, it } from "vitest";
import { resolveSizing, SizingError } from "../src/sizing.js";
import type { EndpointDefaults } from "../src/config.js";
import type { NormalizedSignal } from "../src/types.js";

const defaults = (overrides: Partial<EndpointDefaults> = {}): EndpointDefaults => ({
  sizing: { mode: "quantity", value: 1 },
  orderType: "market",
  timeInForce: "day",
  fractional: false,
  ...overrides,
});

const signal = (overrides: Partial<NormalizedSignal> = {}): NormalizedSignal => ({
  action: "buy",
  symbol: "AAPL",
  ...overrides,
});

describe("sizing", () => {
  it("passes fixed quantity through", () => {
    expect(resolveSizing({ signal: signal({ sizing: { mode: "quantity", value: 7 } }), defaults: defaults() })).toEqual({ quantity: 7 });
  });

  it("uses the endpoint default when the signal is silent", () => {
    expect(resolveSizing({ signal: signal(), defaults: defaults({ sizing: { mode: "quantity", value: 3 } }) })).toEqual({ quantity: 3 });
  });

  it("keeps notional for market orders, converts for limit orders", () => {
    expect(resolveSizing({ signal: signal({ sizing: { mode: "notional", value: 500 } }), defaults: defaults() })).toEqual({ notional: 500 });

    const converted = resolveSizing({
      signal: signal({ sizing: { mode: "notional", value: 500 }, orderType: "limit", limitPrice: 100, referencePrice: 100 }),
      defaults: defaults(),
    });
    expect(converted).toEqual({ quantity: 5 });

    expect(() =>
      resolveSizing({ signal: signal({ sizing: { mode: "notional", value: 500 }, orderType: "limit", limitPrice: 100 }), defaults: defaults() }),
    ).toThrow(SizingError);
  });

  it("percent of equity", () => {
    expect(
      resolveSizing({ signal: signal({ sizing: { mode: "percent_equity", value: 10 } }), defaults: defaults(), equity: 50_000 }),
    ).toEqual({ notional: 5000 });

    expect(() =>
      resolveSizing({ signal: signal({ sizing: { mode: "percent_equity", value: 10 } }), defaults: defaults() }),
    ).toThrow(/equity/);
  });

  it("risk percent needs stop and price, then sizes by distance", () => {
    const sized = resolveSizing({
      signal: signal({ sizing: { mode: "risk_percent", value: 1 }, referencePrice: 100, bracket: { stopLossPrice: 95 } }),
      defaults: defaults(),
      equity: 100_000,
    });
    expect(sized).toEqual({ quantity: 200 }); // risking 1000 over $5 of distance

    expect(() =>
      resolveSizing({ signal: signal({ sizing: { mode: "risk_percent", value: 1 }, referencePrice: 100 }), defaults: defaults(), equity: 100_000 }),
    ).toThrow(/stop/);

    expect(() =>
      resolveSizing({
        signal: signal({ sizing: { mode: "risk_percent", value: 1 }, referencePrice: 100, stopPrice: 100 }),
        defaults: defaults(),
        equity: 100_000,
      }),
    ).toThrow(/zero/);
  });

  it("whole-share rounding fails loudly at zero, fractional opts in", () => {
    expect(() =>
      resolveSizing({
        signal: signal({ sizing: { mode: "notional", value: 50 }, orderType: "limit", limitPrice: 100, referencePrice: 100 }),
        defaults: defaults(),
      }),
    ).toThrow(/fractional/);

    const fractional = resolveSizing({
      signal: signal({ sizing: { mode: "notional", value: 50 }, orderType: "limit", limitPrice: 100, referencePrice: 100 }),
      defaults: defaults({ fractional: true }),
    });
    expect(fractional).toEqual({ quantity: 0.5 });
  });
});

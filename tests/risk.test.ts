import { describe, expect, it } from "vitest";
import { evaluateRisk, localClock, type RiskInputs } from "../src/risk.js";
import type { OrderIntent } from "../src/types.js";

const intentOf = (overrides: Partial<OrderIntent> = {}): OrderIntent => ({
  accountId: "sim",
  symbol: "AAPL",
  side: "buy",
  orderType: "market",
  quantity: 1,
  timeInForce: "day",
  clientOrderId: "x",
  referencePrice: 100,
  ...overrides,
});

const risk = (overrides: Record<string, unknown> = {}) => ({
  allowAnySymbol: false,
  symbolAllowlist: ["AAPL", "SPY"],
  maxPositionSize: { quantity: 100 },
  unlimitedPositionSize: false,
  maxDailyLoss: 500,
  noDailyLossLimit: false,
  maxOrdersPerDay: 100,
  dedupeWindowSec: 10,
  cooldownSec: 0,
  ...overrides,
});

const inputs = (overrides: Partial<RiskInputs> = {}): RiskInputs => ({
  intent: intentOf(),
  risk: risk() as RiskInputs["risk"],
  now: new Date("2026-01-05T15:00:00Z"), // Monday 10:00 New York
  killSwitchOn: false,
  paused: false,
  currentPosition: 0,
  ordersToday: 0,
  dayPnl: 0,
  lastOrderAtForSymbol: undefined,
  duplicateSeenAt: undefined,
  ...overrides,
});

const rejectedBy = (verdict: ReturnType<typeof evaluateRisk>): string | undefined =>
  verdict.decisions.find((decision) => decision.outcome === "reject")?.rule;

describe("risk engine", () => {
  it("passes a clean order and records every rule", () => {
    const verdict = evaluateRisk(inputs());
    expect(verdict.allowed).toBe(true);
    const rules = verdict.decisions.map((decision) => decision.rule);
    expect(rules).toContain("killSwitch");
    expect(rules).toContain("symbolAllowlist");
    expect(rules).toContain("maxDailyLoss");
    expect(rules).toContain("maxPositionSize");
  });

  it("kill switch blocks everything, including exits", () => {
    const verdict = evaluateRisk(inputs({ killSwitchOn: true, intent: intentOf({ reduceOnly: true }) }));
    expect(verdict.allowed).toBe(false);
    expect(rejectedBy(verdict)).toBe("killSwitch");
  });

  it("paused endpoint rejects", () => {
    expect(rejectedBy(evaluateRisk(inputs({ paused: true })))).toBe("paused");
  });

  it("allowlist rejects unknown symbols but lets reduce-only exit them", () => {
    const bad = inputs({ intent: intentOf({ symbol: "GME" }) });
    expect(rejectedBy(evaluateRisk(bad))).toBe("symbolAllowlist");

    const exit = inputs({ intent: intentOf({ symbol: "GME", side: "sell", reduceOnly: true }), currentPosition: 5 });
    const verdict = evaluateRisk(exit);
    expect(verdict.allowed).toBe(true);
    expect(verdict.decisions.find((d) => d.rule === "symbolAllowlist")?.outcome).toBe("skip");
  });

  it("trading hours reject outside the window and pass inside", () => {
    const hours = { timezone: "America/New_York", windows: [{ days: ["mon", "tue", "wed", "thu", "fri"], start: "09:30", end: "16:00" }] };
    const open = evaluateRisk(inputs({ risk: risk({ tradingHours: hours }) as RiskInputs["risk"] }));
    expect(open.allowed).toBe(true);

    const closed = evaluateRisk(
      inputs({ now: new Date("2026-01-05T23:00:00Z"), risk: risk({ tradingHours: hours }) as RiskInputs["risk"] }),
    );
    expect(rejectedBy(closed)).toBe("tradingHours");
  });

  it("duplicate signals inside the window reject", () => {
    const verdict = evaluateRisk(
      inputs({ duplicateSeenAt: new Date("2026-01-05T14:59:55Z").toISOString() }),
    );
    expect(rejectedBy(verdict)).toBe("duplicateSignal");

    const outside = evaluateRisk(
      inputs({ duplicateSeenAt: new Date("2026-01-05T14:59:40Z").toISOString() }),
    );
    expect(outside.allowed).toBe(true);
  });

  it("cooldown rejects rapid re-entry but not exits", () => {
    const cooled = risk({ cooldownSec: 60 }) as RiskInputs["risk"];
    const verdict = evaluateRisk(inputs({ risk: cooled, lastOrderAtForSymbol: new Date("2026-01-05T14:59:30Z").toISOString() }));
    expect(rejectedBy(verdict)).toBe("cooldown");

    const exit = evaluateRisk(
      inputs({
        risk: cooled,
        intent: intentOf({ reduceOnly: true, side: "sell" }),
        currentPosition: 5,
        lastOrderAtForSymbol: new Date("2026-01-05T14:59:30Z").toISOString(),
      }),
    );
    expect(exit.allowed).toBe(true);
  });

  it("caps orders per day", () => {
    expect(rejectedBy(evaluateRisk(inputs({ ordersToday: 100 })))).toBe("maxOrdersPerDay");
  });

  it("daily loss cutoff blocks new risk, allows exits, honors the conscious flag", () => {
    expect(rejectedBy(evaluateRisk(inputs({ dayPnl: -500 })))).toBe("maxDailyLoss");

    const exit = evaluateRisk(inputs({ dayPnl: -500, intent: intentOf({ reduceOnly: true, side: "sell" }), currentPosition: 5 }));
    expect(exit.allowed).toBe(true);

    const loosened = evaluateRisk(
      inputs({ dayPnl: -50_000, risk: risk({ noDailyLossLimit: true, maxDailyLoss: undefined }) as RiskInputs["risk"] }),
    );
    expect(loosened.allowed).toBe(true);
  });

  it("projects position size and fails closed without a price", () => {
    const over = evaluateRisk(inputs({ currentPosition: 90, intent: intentOf({ quantity: 20 }) }));
    expect(rejectedBy(over)).toBe("maxPositionSize");

    const reducing = evaluateRisk(inputs({ currentPosition: 90, intent: intentOf({ side: "sell", quantity: 20 }) }));
    expect(reducing.allowed).toBe(true);

    const { quantity: _quantity, referencePrice: _referencePrice, ...bare } = intentOf();
    const blind = evaluateRisk(inputs({ intent: { ...bare, notional: 5000 } }));
    expect(rejectedBy(blind)).toBe("maxPositionSize");

    const loosened = evaluateRisk(
      inputs({
        currentPosition: 1_000_000,
        risk: risk({ unlimitedPositionSize: true, maxPositionSize: undefined }) as RiskInputs["risk"],
      }),
    );
    expect(loosened.allowed).toBe(true);
  });

  it("enforces a notional exposure cap", () => {
    const capped = risk({ maxPositionSize: { notional: 1000 } }) as RiskInputs["risk"];
    const over = evaluateRisk(inputs({ risk: capped, intent: intentOf({ quantity: 20, referencePrice: 100 }) }));
    expect(rejectedBy(over)).toBe("maxPositionSize");
    const under = evaluateRisk(inputs({ risk: capped, intent: intentOf({ quantity: 5, referencePrice: 100 }) }));
    expect(under.allowed).toBe(true);
  });
});

describe("localClock", () => {
  it("reads weekday and time in a timezone", () => {
    const clock = localClock(new Date("2026-01-05T15:00:00Z"), "America/New_York");
    expect(clock).toEqual({ day: "mon", time: "10:00" });
  });
});

import type { RiskConfig } from "./config.js";
import type { OrderIntent, RiskVerdict, RuleDecision } from "./types.js";

/*
  The risk engine. Pure: every fact it needs arrives in RiskInputs, every
  verdict is a full list of per-rule decisions with reasons — the flight
  recorder shows the user exactly which rule said no and why. Fail closed:
  when a rule cannot verify a limit (no price to project a position with),
  it rejects rather than shrugs.

  Reduce-only intents (close / flatten) skip the rules that exist to stop
  new risk — allowlist, trading hours, cooldown, daily-loss cutoff — because
  refusing to let someone exit a position is how software blows up accounts.
  Each skip is recorded, not silent.
*/

export type RiskInputs = {
  intent: OrderIntent;
  risk: RiskConfig;
  now: Date;
  killSwitchOn: boolean;
  paused: boolean;
  /** Signed quantity currently held in intent.symbol (0 when flat). */
  currentPosition: number;
  /** Executed orders for this endpoint since local midnight. */
  ordersToday: number;
  /** Realized day PnL in account currency; undefined = unknown. */
  dayPnl: number | undefined;
  /** ISO time of the last executed order on this symbol via this endpoint. */
  lastOrderAtForSymbol: string | undefined;
  /** ISO time an identical signal was last seen inside the dedupe window. */
  duplicateSeenAt: string | undefined;
};

const pass = (rule: string): RuleDecision => ({ rule, outcome: "pass" });
const skip = (rule: string, reason: string): RuleDecision => ({ rule, outcome: "skip", reason });
const reject = (rule: string, reason: string): RuleDecision => ({ rule, outcome: "reject", reason });

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** Local weekday + "HH:MM" for a timezone, via Intl — no tz database needed. */
export const localClock = (now: Date, timezone: string): { day: (typeof WEEKDAYS)[number]; time: string } => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const day = get("weekday").toLowerCase().slice(0, 3) as (typeof WEEKDAYS)[number];
  return { day, time: `${get("hour")}:${get("minute")}` };
};

const tradingHoursRule = (inputs: RiskInputs): RuleDecision => {
  const rule = "tradingHours";
  const hours = inputs.risk.tradingHours;
  if (!hours) return skip(rule, "not configured");
  if (inputs.intent.reduceOnly) return skip(rule, "reduce-only orders may exit anytime");
  let clock: { day: string; time: string };
  try {
    clock = localClock(inputs.now, hours.timezone);
  } catch {
    return reject(rule, `unknown timezone "${hours.timezone}"`);
  }
  const open = hours.windows.some(
    (window) =>
      (window.days as readonly string[]).includes(clock.day) && window.start <= clock.time && clock.time <= window.end,
  );
  return open
    ? pass(rule)
    : reject(rule, `outside trading hours (${clock.day} ${clock.time} ${hours.timezone})`);
};

const positionSizeRule = (inputs: RiskInputs): RuleDecision => {
  const rule = "maxPositionSize";
  const { risk, intent, currentPosition } = inputs;
  if (risk.unlimitedPositionSize) return skip(rule, "consciously loosened (unlimitedPositionSize)");
  const cap = risk.maxPositionSize;
  if (!cap) return reject(rule, "no maxPositionSize configured and not consciously loosened");

  const signedChange = (quantity: number): number => (intent.side === "buy" ? quantity : -quantity);

  let quantity = intent.quantity;
  if (quantity === undefined && intent.notional !== undefined && intent.referencePrice) {
    quantity = intent.notional / intent.referencePrice;
  }

  if (cap.quantity !== undefined) {
    if (quantity === undefined) {
      return reject(rule, "cannot verify quantity cap: notional order with no reference price");
    }
    const projected = Math.abs(currentPosition + signedChange(quantity));
    if (projected > cap.quantity + 1e-9) {
      return reject(rule, `projected position ${projected} exceeds cap ${cap.quantity} for ${intent.symbol}`);
    }
  }

  if (cap.notional !== undefined) {
    const notional =
      intent.notional ??
      (quantity !== undefined && intent.referencePrice ? quantity * intent.referencePrice : undefined);
    if (notional === undefined) {
      return reject(rule, "cannot verify notional cap: no notional and no reference price");
    }
    const current = Math.abs(currentPosition) * (intent.referencePrice ?? 0);
    const projected = intent.reduceOnly ? Math.max(0, current - notional) : current + notional;
    if (projected > cap.notional + 1e-9) {
      return reject(rule, `projected exposure ${projected.toFixed(2)} exceeds notional cap ${cap.notional} for ${intent.symbol}`);
    }
  }

  return pass(rule);
};

export const evaluateRisk = (inputs: RiskInputs): RiskVerdict => {
  const { intent, risk } = inputs;
  const decisions: RuleDecision[] = [];
  const add = (decision: RuleDecision): boolean => {
    decisions.push(decision);
    return decision.outcome !== "reject";
  };
  const done = (): RiskVerdict => ({ allowed: decisions.every((d) => d.outcome !== "reject"), decisions });

  // Hard stops first: the kill switch outranks everything, including exits —
  // it exists for "something is wrong, stop touching my account".
  if (!add(inputs.killSwitchOn ? reject("killSwitch", "kill switch is ON — resume explicitly to trade again") : pass("killSwitch"))) return done();
  if (!add(inputs.paused ? reject("paused", "endpoint is paused") : pass("paused"))) return done();

  // Symbol allowlist.
  if (intent.reduceOnly) {
    add(skip("symbolAllowlist", "reduce-only orders may exit anything"));
  } else if (risk.allowAnySymbol) {
    add(skip("symbolAllowlist", "consciously loosened (allowAnySymbol)"));
  } else {
    const allowlist = (risk.symbolAllowlist ?? []).map((symbol) => symbol.toUpperCase());
    if (!add(allowlist.includes(intent.symbol) ? pass("symbolAllowlist") : reject("symbolAllowlist", `${intent.symbol} is not on the allowlist`))) return done();
  }

  if (!add(tradingHoursRule(inputs))) return done();

  // Duplicate protection: the same alert firing twice must not double a position.
  if (risk.dedupeWindowSec > 0 && inputs.duplicateSeenAt) {
    const ageSec = (inputs.now.getTime() - new Date(inputs.duplicateSeenAt).getTime()) / 1000;
    if (ageSec >= 0 && ageSec < risk.dedupeWindowSec) {
      add(reject("duplicateSignal", `identical signal seen ${ageSec.toFixed(1)}s ago (window ${risk.dedupeWindowSec}s)`));
      return done();
    }
  }
  add(pass("duplicateSignal"));

  // Cooldown between orders on the same symbol.
  if (risk.cooldownSec > 0 && !intent.reduceOnly && inputs.lastOrderAtForSymbol) {
    const ageSec = (inputs.now.getTime() - new Date(inputs.lastOrderAtForSymbol).getTime()) / 1000;
    if (ageSec >= 0 && ageSec < risk.cooldownSec) {
      add(reject("cooldown", `last order on ${intent.symbol} was ${ageSec.toFixed(1)}s ago (cooldown ${risk.cooldownSec}s)`));
      return done();
    }
  }
  add(intent.reduceOnly && risk.cooldownSec > 0 ? skip("cooldown", "reduce-only") : pass("cooldown"));

  if (!add(inputs.ordersToday >= risk.maxOrdersPerDay
    ? reject("maxOrdersPerDay", `already ${inputs.ordersToday} orders today (cap ${risk.maxOrdersPerDay})`)
    : pass("maxOrdersPerDay"))) return done();

  // Daily loss cutoff: once breached, only risk-reducing orders pass.
  if (risk.noDailyLossLimit) {
    add(skip("maxDailyLoss", "consciously loosened (noDailyLossLimit)"));
  } else if (intent.reduceOnly) {
    add(skip("maxDailyLoss", "reduce-only orders may exit after the cutoff"));
  } else if (risk.maxDailyLoss === undefined) {
    add(reject("maxDailyLoss", "no maxDailyLoss configured and not consciously loosened"));
    return done();
  } else if (inputs.dayPnl !== undefined && inputs.dayPnl <= -risk.maxDailyLoss) {
    add(reject("maxDailyLoss", `day PnL ${inputs.dayPnl.toFixed(2)} breaches -${risk.maxDailyLoss} — only exits allowed until tomorrow`));
    return done();
  } else {
    add(pass("maxDailyLoss"));
  }

  add(positionSizeRule(inputs));
  return done();
};

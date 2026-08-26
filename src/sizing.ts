import type { EndpointDefaults } from "./config.js";
import type { NormalizedSignal, Sizing } from "./types.js";

/*
  Sizing: turn "how much" (a fixed quantity, a currency amount, a slice of
  equity, or a risk budget) into the quantity/notional an order carries.
  Percent modes need account equity; risk mode needs a stop distance. When
  the math cannot be done honestly, this throws — the engine records the
  reason. Never guessed, never defaulted.
*/

export class SizingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SizingError";
  }
}

export type ResolvedSize = { quantity?: number; notional?: number };

export type SizingContext = {
  signal: NormalizedSignal;
  defaults: EndpointDefaults;
  /** Lazily fetched by the engine only for the modes that need it. */
  equity?: number;
};

export const sizingNeedsEquity = (sizing: Sizing): boolean =>
  sizing.mode === "percent_equity" || sizing.mode === "risk_percent";

const finishQuantity = (raw: number, fractional: boolean, origin: string): ResolvedSize => {
  const quantity = fractional ? Number(raw.toFixed(8)) : Math.floor(raw);
  if (!(quantity > 0)) {
    throw new SizingError(
      `${origin} produced quantity ${raw.toFixed(8)}${fractional ? "" : " (rounded down to 0 — set defaults.fractional: true to allow fractional sizes)"}`,
    );
  }
  return { quantity };
};

export const resolveSizing = (ctx: SizingContext): ResolvedSize => {
  const sizing = ctx.signal.sizing ?? ctx.defaults.sizing;
  const orderType = ctx.signal.orderType ?? ctx.defaults.orderType;
  const referencePrice = ctx.signal.referencePrice;
  const fractional = ctx.defaults.fractional;

  switch (sizing.mode) {
    case "quantity":
      return { quantity: sizing.value };

    case "notional": {
      if (orderType === "market") return { notional: sizing.value };
      if (!referencePrice) {
        throw new SizingError(
          `notional sizing on a ${orderType} order needs a reference price — include "price" in the alert payload`,
        );
      }
      return finishQuantity(sizing.value / referencePrice, fractional, `notional ${sizing.value} @ ${referencePrice}`);
    }

    case "percent_equity": {
      if (ctx.equity === undefined) throw new SizingError("percent_equity sizing needs account equity, which could not be fetched");
      const notional = (ctx.equity * sizing.value) / 100;
      if (orderType === "market") return { notional: Number(notional.toFixed(2)) };
      if (!referencePrice) {
        throw new SizingError(
          `percent_equity sizing on a ${orderType} order needs a reference price — include "price" in the alert payload`,
        );
      }
      return finishQuantity(notional / referencePrice, fractional, `${sizing.value}% of equity @ ${referencePrice}`);
    }

    case "risk_percent": {
      if (ctx.equity === undefined) throw new SizingError("risk_percent sizing needs account equity, which could not be fetched");
      const stopPrice = ctx.signal.stopPrice ?? ctx.signal.bracket?.stopLossPrice;
      if (!stopPrice) {
        throw new SizingError('risk_percent sizing needs a stop — include "stopLoss" or "stopPrice" in the alert payload');
      }
      if (!referencePrice) {
        throw new SizingError('risk_percent sizing needs a reference price — include "price" in the alert payload');
      }
      const perUnitRisk = Math.abs(referencePrice - stopPrice);
      if (perUnitRisk <= 0) throw new SizingError("risk_percent sizing: stop price equals reference price, per-unit risk is zero");
      const budget = (ctx.equity * sizing.value) / 100;
      return finishQuantity(budget / perUnitRisk, fractional, `risking ${sizing.value}% of equity with stop ${stopPrice}`);
    }
  }
};

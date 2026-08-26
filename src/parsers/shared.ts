import type { NormalizedSignal, OrderKind, SignalAction, Sizing, TimeInForce } from "../types.js";

/** Raised when a payload cannot be understood by any parser. */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

/** "NASDAQ:AAPL" → "AAPL"; trims and uppercases. Futures/crypto codes pass through. */
export const normalizeSymbol = (raw: string): string => {
  const trimmed = raw.trim();
  const afterColon = trimmed.includes(":") ? trimmed.slice(trimmed.lastIndexOf(":") + 1) : trimmed;
  return afterColon.trim().toUpperCase();
};

/** Coerce a number that may arrive as a string (TradingView placeholders do). */
export const asNumber = (value: unknown): number | undefined => {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};

export const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

/** First defined value among aliases, looked up case-insensitively. */
export const pick = (record: Record<string, unknown>, ...aliases: string[]): unknown => {
  const lowered = new Map(Object.keys(record).map((key) => [key.toLowerCase(), record[key]]));
  for (const alias of aliases) {
    const value = lowered.get(alias.toLowerCase());
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
};

const ACTION_ALIASES: Record<string, SignalAction> = {
  buy: "buy",
  long: "buy",
  sell: "sell",
  short: "sell",
  close: "close",
  exit: "close",
  flat: "close",
  flatten: "flatten",
  close_all: "flatten",
  exit_all: "flatten",
  cancel: "cancel_all",
  cancel_all: "cancel_all",
  pause: "pause",
  resume: "resume",
  kill: "kill",
};

export const normalizeAction = (raw: string): SignalAction | undefined =>
  ACTION_ALIASES[raw.trim().toLowerCase().replace(/[\s-]+/g, "_")];

const ORDER_KINDS: Record<string, OrderKind> = {
  market: "market",
  limit: "limit",
  stop: "stop",
  stop_market: "stop",
  stop_limit: "stop_limit",
  stoplimit: "stop_limit",
  trailing_stop: "trailing_stop",
  trail: "trailing_stop",
};

export const normalizeOrderKind = (raw: string): OrderKind | undefined =>
  ORDER_KINDS[raw.trim().toLowerCase().replace(/[\s-]+/g, "_")];

const TIFS = new Set<TimeInForce>(["day", "gtc", "ioc", "fok"]);

export const normalizeTimeInForce = (raw: string): TimeInForce | undefined => {
  const lowered = raw.trim().toLowerCase() as TimeInForce;
  return TIFS.has(lowered) ? lowered : undefined;
};

/** Read sizing from a payload's aliases. Exactly one mode wins, in this priority. */
export const readSizing = (record: Record<string, unknown>): Sizing | undefined => {
  const quantity = asNumber(pick(record, "quantity", "qty", "size", "contracts", "shares", "amount"));
  if (quantity !== undefined) return { mode: "quantity", value: quantity };
  const notional = asNumber(pick(record, "notional", "cash", "dollars", "cost"));
  if (notional !== undefined) return { mode: "notional", value: notional };
  const percentEquity = asNumber(pick(record, "percentEquity", "percent_equity", "equityPercent"));
  if (percentEquity !== undefined) return { mode: "percent_equity", value: percentEquity };
  const riskPercent = asNumber(pick(record, "riskPercent", "risk_percent"));
  if (riskPercent !== undefined) return { mode: "risk_percent", value: riskPercent };
  return undefined;
};

export type ParsedSignal = { parser: string; signal: NormalizedSignal };

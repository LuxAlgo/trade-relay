import type { BracketSpec, NormalizedSignal } from "../types.js";
import { ParseError, asNumber, asString, normalizeSymbol, pick, readSizing } from "./shared.js";

/*
  TradersPost-compatible parser. A TradersPost customer migrates by changing
  one thing: the URL in their TradingView alert. Their existing payloads —
  { "ticker", "action", "sentiment", "price", "quantity", … } — keep working.

  Semantics honored from their format:
  - action: "buy" | "sell" | "exit" | "cancel"
  - sentiment: "bullish" | "bearish" | "flat" — "flat" means go to flat
    (close the position), which is how strategy-exit alerts arrive.
  - takeProfit / stopLoss: number or { "limitPrice" } / { "stopPrice" } objects.
*/

const readExitPrice = (value: unknown, key: string): number | undefined => {
  const direct = asNumber(value);
  if (direct !== undefined) return direct;
  if (value && typeof value === "object") {
    return asNumber(pick(value as Record<string, unknown>, key, "price"));
  }
  return undefined;
};

/**
 * Claim only payloads with distinctly-TradersPost semantics — "sentiment",
 * their "exit"/"cancel" action verbs, or object-shaped exit prices. Plain
 * { ticker, action, quantity } payloads mean the same thing in the native
 * format, which the native parser handles without dropping any field.
 */
export const looksLikeTradersPost = (payload: Record<string, unknown>): boolean => {
  if (pick(payload, "sentiment") !== undefined) return true;
  const action = asString(pick(payload, "action"))?.toLowerCase();
  if (action === "exit" || action === "cancel") return true;
  const takeProfit = pick(payload, "takeProfit", "take_profit");
  const stopLoss = pick(payload, "stopLoss", "stop_loss");
  return (
    (takeProfit !== undefined && typeof takeProfit === "object") ||
    (stopLoss !== undefined && typeof stopLoss === "object")
  );
};

export const parseTradersPostPayload = (payload: Record<string, unknown>): NormalizedSignal => {
  const actionRaw = asString(pick(payload, "action"))?.toLowerCase();
  const sentiment = asString(pick(payload, "sentiment"))?.toLowerCase();
  const tickerRaw = asString(pick(payload, "ticker", "symbol"));

  let action: NormalizedSignal["action"];
  if (actionRaw === "cancel") action = "cancel_all";
  else if (actionRaw === "exit" || sentiment === "flat") action = "close";
  else if (actionRaw === "buy" || (actionRaw === undefined && sentiment === "bullish")) action = "buy";
  else if (actionRaw === "sell" || (actionRaw === undefined && sentiment === "bearish")) action = "sell";
  else throw new ParseError(`Unknown TradersPost action "${actionRaw ?? sentiment ?? ""}"`);

  const signal: NormalizedSignal = { action };
  if (tickerRaw) signal.symbol = normalizeSymbol(tickerRaw);
  if (["buy", "sell", "close"].includes(action) && !signal.symbol) {
    throw new ParseError('TradersPost payload needs a "ticker"');
  }

  const sizing = readSizing(payload);
  if (sizing) signal.sizing = sizing;

  const price = asNumber(pick(payload, "price"));
  if (price !== undefined) signal.referencePrice = price;

  const limitPrice = asNumber(pick(payload, "limitPrice", "limit_price"));
  if (limitPrice !== undefined) {
    signal.orderType = "limit";
    signal.limitPrice = limitPrice;
  }

  const bracket: BracketSpec = {};
  const takeProfit = readExitPrice(pick(payload, "takeProfit", "take_profit"), "limitPrice");
  if (takeProfit !== undefined) bracket.takeProfitPrice = takeProfit;
  const stopLoss = readExitPrice(pick(payload, "stopLoss", "stop_loss"), "stopPrice");
  if (stopLoss !== undefined) bracket.stopLossPrice = stopLoss;
  if (bracket.takeProfitPrice !== undefined || bracket.stopLossPrice !== undefined) {
    signal.bracket = bracket;
  }

  const signalId = asString(pick(payload, "signalId", "signal_id", "id"));
  if (signalId) signal.signalId = signalId;
  const comment = asString(pick(payload, "comment", "message"));
  if (comment) signal.comment = comment;

  return signal;
};

import type { BracketSpec, NormalizedSignal } from "../types.js";
import {
  ParseError,
  asNumber,
  asString,
  normalizeAction,
  normalizeOrderKind,
  normalizeSymbol,
  normalizeTimeInForce,
  pick,
  readSizing,
} from "./shared.js";

/*
  The native trade-relay payload — the documented default. Deliberately
  tolerant on aliases and string-typed numbers, because TradingView alert
  placeholders arrive as strings and humans typo key names. This same parser
  therefore also accepts SignalStack-style JSON ({ "action", "symbol",
  "quantity" }) unchanged — migration is changing the URL, nothing else.
*/
export const parseTradeRelayPayload = (payload: Record<string, unknown>): NormalizedSignal => {
  const actionRaw = asString(pick(payload, "action", "side", "signal"));
  if (!actionRaw) throw new ParseError('Missing "action" (buy, sell, close, flatten, cancel_all…)');
  const action = normalizeAction(actionRaw);
  if (!action) throw new ParseError(`Unknown action "${actionRaw}"`);

  const symbolRaw = asString(pick(payload, "symbol", "ticker", "sym", "instrument", "pair"));
  const signal: NormalizedSignal = { action };
  if (symbolRaw) signal.symbol = normalizeSymbol(symbolRaw);
  if (["buy", "sell", "close"].includes(action) && !signal.symbol) {
    throw new ParseError(`Action "${action}" needs a "symbol"`);
  }

  const sizing = readSizing(payload);
  if (sizing) signal.sizing = sizing;

  const orderTypeRaw = asString(pick(payload, "orderType", "order_type", "type"));
  if (orderTypeRaw) {
    const orderType = normalizeOrderKind(orderTypeRaw);
    if (!orderType) throw new ParseError(`Unknown orderType "${orderTypeRaw}"`);
    signal.orderType = orderType;
  }

  const limitPrice = asNumber(pick(payload, "limitPrice", "limit_price", "limit"));
  if (limitPrice !== undefined) signal.limitPrice = limitPrice;
  const stopPrice = asNumber(pick(payload, "stopPrice", "stop_price", "stop"));
  if (stopPrice !== undefined) signal.stopPrice = stopPrice;
  const trailAmount = asNumber(pick(payload, "trailAmount", "trail_amount"));
  if (trailAmount !== undefined) signal.trailAmount = trailAmount;
  const trailPercent = asNumber(pick(payload, "trailPercent", "trail_percent"));
  if (trailPercent !== undefined) signal.trailPercent = trailPercent;

  const tifRaw = asString(pick(payload, "timeInForce", "time_in_force", "tif"));
  if (tifRaw) {
    const tif = normalizeTimeInForce(tifRaw);
    if (!tif) throw new ParseError(`Unknown timeInForce "${tifRaw}"`);
    signal.timeInForce = tif;
  }

  const bracket: BracketSpec = {};
  const takeProfit = asNumber(pick(payload, "takeProfit", "take_profit", "tp"));
  if (takeProfit !== undefined) bracket.takeProfitPrice = takeProfit;
  const stopLoss = asNumber(pick(payload, "stopLoss", "stop_loss", "sl"));
  if (stopLoss !== undefined) bracket.stopLossPrice = stopLoss;
  const stopLossLimit = asNumber(pick(payload, "stopLossLimit", "stop_loss_limit"));
  if (stopLossLimit !== undefined) bracket.stopLossLimitPrice = stopLossLimit;
  if (bracket.takeProfitPrice !== undefined || bracket.stopLossPrice !== undefined) {
    signal.bracket = bracket;
  }

  const referencePrice = asNumber(pick(payload, "price", "referencePrice", "close"));
  if (referencePrice !== undefined) signal.referencePrice = referencePrice;

  const account = asString(pick(payload, "account", "accountId", "account_id"));
  if (account) signal.account = account;
  const signalId = asString(pick(payload, "signalId", "signal_id", "id", "alertId", "alert_id"));
  if (signalId) signal.signalId = signalId;
  const comment = asString(pick(payload, "comment", "message", "note"));
  if (comment) signal.comment = comment;

  return signal;
};

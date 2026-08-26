import type { NormalizedSignal } from "../types.js";
import { ParseError, asNumber, normalizeAction, normalizeSymbol } from "./shared.js";

/*
  Plain-text alerts, SignalStack-style. Handles the shapes people actually
  type into an alert box:

    BUY 10 AAPL
    buy 10 shares of AAPL
    SELL AAPL
    close NVDA
    FLATTEN
    buy 0.5 BTCUSD at 64250 limit
*/
export const parseTextPayload = (text: string): NormalizedSignal => {
  const cleaned = text.trim().replace(/\s+/g, " ");
  if (!cleaned) throw new ParseError("Empty alert text");

  const words = cleaned.split(" ");
  const action = normalizeAction(words[0] ?? "");
  if (!action) throw new ParseError(`Unrecognized alert text "${cleaned.slice(0, 80)}"`);

  const signal: NormalizedSignal = { action };
  if (action === "flatten" || action === "cancel_all" || action === "kill" || action === "pause" || action === "resume") {
    return signal;
  }

  let rest = words.slice(1).filter((word) => !["shares", "share", "of", "units", "unit", "contracts"].includes(word.toLowerCase()));

  // Optional trailing "... at <price> [limit]" — a limit order at that price,
  // or a reference price when "limit" is absent.
  let limit = false;
  let price: number | undefined;
  const atIndex = rest.findIndex((word) => word.toLowerCase() === "at");
  if (atIndex !== -1) {
    const tail = rest.slice(atIndex + 1);
    price = asNumber(tail[0]);
    limit = tail.some((word) => word.toLowerCase() === "limit");
    rest = rest.slice(0, atIndex);
  }

  const quantity = asNumber(rest[0]);
  const symbolWord = quantity !== undefined ? rest[1] : rest[0];
  if (!symbolWord) throw new ParseError(`No symbol in alert text "${cleaned.slice(0, 80)}"`);

  signal.symbol = normalizeSymbol(symbolWord);
  if (quantity !== undefined) signal.sizing = { mode: "quantity", value: quantity };
  if (price !== undefined) {
    if (limit) {
      signal.orderType = "limit";
      signal.limitPrice = price;
    } else {
      signal.referencePrice = price;
    }
  }
  return signal;
};

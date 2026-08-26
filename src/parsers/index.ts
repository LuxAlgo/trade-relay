import { ParseError, type ParsedSignal } from "./shared.js";
import { parseTradeRelayPayload } from "./trade-relay.js";
import { looksLikeTradersPost, parseTradersPostPayload } from "./traderspost.js";
import { parseTextPayload } from "./text.js";

export { ParseError } from "./shared.js";
export type { ParsedSignal } from "./shared.js";
export { parseTradeRelayPayload } from "./trade-relay.js";
export { parseTradersPostPayload, looksLikeTradersPost } from "./traderspost.js";
export { parseTextPayload } from "./text.js";

export type ParserName = "auto" | "trade-relay" | "traderspost" | "text";

/**
 * Turn a raw webhook body into a normalized signal. "auto" (the default)
 * detects the format: TradersPost payloads are recognized by their
 * distinguishing keys, any other JSON goes through the native parser (which
 * also covers SignalStack-style JSON), and non-JSON falls back to plain text.
 */
export const parsePayload = (rawBody: string, parser: ParserName = "auto"): ParsedSignal => {
  if (parser === "text") return { parser: "text", signal: parseTextPayload(rawBody) };

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    if (parser === "auto") return { parser: "text", signal: parseTextPayload(rawBody) };
    throw new ParseError(`Body is not valid JSON (parser "${parser}")`);
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new ParseError("JSON body must be an object");
  }
  const payload = json as Record<string, unknown>;

  if (parser === "traderspost") return { parser: "traderspost", signal: parseTradersPostPayload(payload) };
  if (parser === "trade-relay") return { parser: "trade-relay", signal: parseTradeRelayPayload(payload) };

  if (looksLikeTradersPost(payload)) {
    return { parser: "traderspost", signal: parseTradersPostPayload(payload) };
  }
  return { parser: "trade-relay", signal: parseTradeRelayPayload(payload) };
};

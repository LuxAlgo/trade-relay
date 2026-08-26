import { describe, expect, it } from "vitest";
import { parsePayload, ParseError } from "../src/parsers/index.js";

describe("native payload", () => {
  it("parses a full order", () => {
    const { parser, signal } = parsePayload(
      JSON.stringify({
        action: "buy",
        symbol: "NASDAQ:AAPL",
        quantity: 10,
        orderType: "limit",
        limitPrice: 180.5,
        timeInForce: "gtc",
        takeProfit: 200,
        stopLoss: 170,
        price: 181.2,
        signalId: "abc-1",
        comment: "golden cross",
      }),
    );
    expect(parser).toBe("trade-relay");
    expect(signal).toMatchObject({
      action: "buy",
      symbol: "AAPL",
      sizing: { mode: "quantity", value: 10 },
      orderType: "limit",
      limitPrice: 180.5,
      timeInForce: "gtc",
      bracket: { takeProfitPrice: 200, stopLossPrice: 170 },
      referencePrice: 181.2,
      signalId: "abc-1",
    });
  });

  it("coerces string numbers (TradingView placeholders)", () => {
    const { signal } = parsePayload(JSON.stringify({ action: "sell", ticker: "SPY", qty: "2.5", price: "512.34" }));
    expect(signal.symbol).toBe("SPY");
    expect(signal.sizing).toEqual({ mode: "quantity", value: 2.5 });
    expect(signal.referencePrice).toBe(512.34);
  });

  it("accepts SignalStack-style JSON unchanged", () => {
    const { parser, signal } = parsePayload(JSON.stringify({ action: "buy", symbol: "TSLA", quantity: 3 }));
    expect(parser).toBe("trade-relay");
    expect(signal).toMatchObject({ action: "buy", symbol: "TSLA", sizing: { mode: "quantity", value: 3 } });
  });

  it("reads percent-equity and risk sizing", () => {
    expect(parsePayload(JSON.stringify({ action: "buy", symbol: "A", percentEquity: 10 })).signal.sizing).toEqual({
      mode: "percent_equity",
      value: 10,
    });
    expect(parsePayload(JSON.stringify({ action: "buy", symbol: "A", riskPercent: 1 })).signal.sizing).toEqual({
      mode: "risk_percent",
      value: 1,
    });
  });

  it("maps control actions", () => {
    expect(parsePayload(JSON.stringify({ action: "flatten" })).signal.action).toBe("flatten");
    expect(parsePayload(JSON.stringify({ action: "kill" })).signal.action).toBe("kill");
    expect(parsePayload(JSON.stringify({ action: "exit", symbol: "AAPL" })).signal.action).toBe("close");
  });

  it("rejects a buy without a symbol and unknown actions", () => {
    expect(() => parsePayload(JSON.stringify({ action: "buy" }))).toThrow(ParseError);
    expect(() => parsePayload(JSON.stringify({ action: "yolo", symbol: "A" }))).toThrow(/Unknown action/);
    expect(() => parsePayload(JSON.stringify({ symbol: "A" }))).toThrow(/Missing "action"/);
  });
});

describe("TradersPost compatibility", () => {
  it("parses their standard buy payload", () => {
    const { parser, signal } = parsePayload(
      JSON.stringify({ ticker: "AAPL", action: "buy", sentiment: "bullish", price: 181.2, quantity: 5 }),
    );
    expect(parser).toBe("traderspost");
    expect(signal).toMatchObject({
      action: "buy",
      symbol: "AAPL",
      sizing: { mode: "quantity", value: 5 },
      referencePrice: 181.2,
    });
  });

  it('treats "exit" and sentiment "flat" as close', () => {
    expect(parsePayload(JSON.stringify({ ticker: "AAPL", action: "exit" })).signal.action).toBe("close");
    expect(parsePayload(JSON.stringify({ ticker: "AAPL", action: "sell", sentiment: "flat" })).signal.action).toBe("close");
  });

  it('treats "cancel" as cancel_all scoped to the ticker', () => {
    const { signal } = parsePayload(JSON.stringify({ ticker: "AAPL", action: "cancel" }));
    expect(signal.action).toBe("cancel_all");
    expect(signal.symbol).toBe("AAPL");
  });

  it("reads object-shaped exit prices", () => {
    const { parser, signal } = parsePayload(
      JSON.stringify({
        ticker: "AAPL",
        action: "buy",
        quantity: 1,
        takeProfit: { limitPrice: 200 },
        stopLoss: { stopPrice: 170 },
      }),
    );
    expect(parser).toBe("traderspost");
    expect(signal.bracket).toEqual({ takeProfitPrice: 200, stopLossPrice: 170 });
  });
});

describe("plain text (SignalStack style)", () => {
  it.each([
    ["BUY 10 AAPL", { action: "buy", symbol: "AAPL", sizing: { mode: "quantity", value: 10 } }],
    ["buy 10 shares of AAPL", { action: "buy", symbol: "AAPL", sizing: { mode: "quantity", value: 10 } }],
    ["SELL AAPL", { action: "sell", symbol: "AAPL" }],
    ["close NVDA", { action: "close", symbol: "NVDA" }],
    ["FLATTEN", { action: "flatten" }],
  ])("parses %s", (text, expected) => {
    const { parser, signal } = parsePayload(text);
    expect(parser).toBe("text");
    expect(signal).toMatchObject(expected);
  });

  it("parses a limit order in text", () => {
    const { signal } = parsePayload("buy 0.5 BTCUSD at 64250 limit");
    expect(signal).toMatchObject({
      action: "buy",
      symbol: "BTCUSD",
      sizing: { mode: "quantity", value: 0.5 },
      orderType: "limit",
      limitPrice: 64250,
    });
  });

  it('treats a bare "at" price as a reference price', () => {
    const { signal } = parsePayload("buy 1 AAPL at 180");
    expect(signal.orderType).toBeUndefined();
    expect(signal.referencePrice).toBe(180);
  });

  it("rejects nonsense", () => {
    expect(() => parsePayload("hello world")).toThrow(ParseError);
  });
});

describe("forced parser choice", () => {
  it("rejects non-JSON when a JSON parser is forced", () => {
    expect(() => parsePayload("BUY 1 AAPL", "trade-relay")).toThrow(/not valid JSON/);
  });
  it("honors the traderspost parser even without its markers", () => {
    const { parser } = parsePayload(JSON.stringify({ ticker: "AAPL", action: "buy", quantity: 1 }), "traderspost");
    expect(parser).toBe("traderspost");
  });
});

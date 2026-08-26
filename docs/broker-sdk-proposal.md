# What trade-relay needs from broker-sdk next

trade-relay consumes `@luxalgo/broker-sdk/orders` exactly as its RFC intends ("Execution tooling built on this SDK imports this layer instead of writing its own broker code, so it is designed once, here"). Per that division of labor, trade-relay never works around a missing SDK capability: it refuses the order with a pointer here, and the ask lands upstream. This document is the standing list of those asks, written against broker-sdk v0.3.0.

Shipped upstream and already adopted here: Alpaca live behind the `LIVE_TRADING_ACKNOWLEDGEMENT` sentence, and Tradier sandbox order placement. Thank you — the relay picked both up the week they landed.

## 1. Tradier sandbox reads

The write layer is sandbox-pinned for Tradier, but the read adapter is production-pinned (`api.tradier.com`), so a sandbox deployment cannot fetch positions or equity. That blocks the relay's position-cap projection, close/flatten, day-PnL, and percent-of-equity sizing for Tradier accounts (all fail closed with a message pointing here).

Suggested shape: the read adapter accepts an environment (or infers it the way the write layer does), or the `TradingConnection` itself grows `getPositions` / `getBalances` for brokers whose sandbox and production hosts differ.

## 2. Stop and stop-limit orders

Flat additions to `OrderRequest`, within both Alpaca's and Tradier's existing APIs:

```ts
type OrderType = "market" | "limit" | "stop" | "stop_limit";
type OrderRequest = { /* … */ stopPrice?: number };
```

Validation mirrors limit: `stop`/`stop_limit` require a positive `stopPrice`; `stop_limit` also a `limitPrice`. The relay's normalized signal, risk engine, and simulator already speak these; the SDK port simply stops refusing them.

## 3. Trailing stops

Alpaca supports `trail_price` / `trail_percent` natively. Proposed: `type: "trailing_stop"` with `trailAmount?: number` / `trailPercent?: number` (exactly one). The relay's simulator implements watermark semantics today and would defer to the broker's own implementation wherever the SDK exposes it.

## 4. Bracket / OCO orders

The RFC defers these until the plain surface soaks, which is reasonable. When ready, the shape the relay already uses downstream:

```ts
type OrderRequest = {
  /* … */
  bracket?: { takeProfitPrice?: number; stopLossPrice?: number; stopLossLimitPrice?: number };
};
```

maps 1:1 to Alpaca's `order_class: "bracket"` / `"oto"`. Normalized `Order` gains `legs?: Order[]`. Until then the relay refuses brackets on real ports and the simulator carries the vocabulary.

## 5. Two small helpers

- `getOrderByClientId(clientOrderId)`: idempotency round-trip without listing (Alpaca: `GET /v2/orders:by_client_order_id`). Especially useful now that Tradier documents no server-side dedupe — the relay's own duplicate window covers it, but a lookup would let us verify instead of trust.
- `closePosition(symbol)` / `closeAllPositions()`: Alpaca has `DELETE /v2/positions/{symbol}`; a sanctioned close is better than the relay's read-position-then-opposite-market composition (which it does today and which stays correct, just less atomic).

## 6. Trading capability discovery

`listBrokers()` covers the read layer. The write layer is now heterogeneous for real (Alpaca does notional market orders and client-order-id dedupe; Tradier does neither), and downstreams shouldn't hardcode tables:

```ts
tradingCapabilities("alpaca") // → { orderTypes, brackets, trailing, notionalMarket, fractional, environments, clientOrderIdDedupe }
```

The relay hardcodes exactly two such tables today (`src/brokers/sdk-port.ts`); it would delete them with pleasure.

## 7. Later: order-update streaming

Polling `getOrder` is fine for now (the relay polls briefly after placement and reconciles on reads). With multiple brokers live, a normalized `onOrderUpdate` (SSE/WS where brokers offer it, polling fallback where they don't) would let the relay's dashboard show fills in real time without per-broker code. Noted for the RFC's open-questions list, not urgent.

---

*Maintained by the trade-relay project. When one of these ships upstream, the relay's matching refusal message and this document both get updated in the same PR.*

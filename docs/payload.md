# Payload reference

Every parser produces the same normalized signal; this page documents what you can send. Numbers may arrive as strings (TradingView placeholders do) — they're coerced. Key names are case-insensitive and most have aliases.

## Actions

| Action | Effect |
| --- | --- |
| `buy` / `sell` | Place an order (aliases: `long`, `short`) |
| `close` | Close the open position in `symbol` — cancels that symbol's resting orders first, then sends a market order for the exact position size (`exit` and `flat` are aliases) |
| `flatten` | Cancel every open order and close every position on the account (`close_all`, `exit_all`) |
| `cancel_all` | Cancel open orders — all of them, or just `symbol`'s when provided (`cancel`) |
| `pause` / `resume` | Stop/restart this endpoint's trading (signals are still recorded while paused) |
| `kill` | Global kill switch ON — everything stops until a human resumes |

## Fields

| Field | Aliases | Notes |
| --- | --- | --- |
| `action` | `side`, `signal` | Required |
| `symbol` | `ticker`, `sym`, `instrument`, `pair` | Required for buy/sell/close. `"NASDAQ:AAPL"` → `AAPL` |
| `quantity` | `qty`, `size`, `contracts`, `shares`, `amount` | Units to trade |
| `notional` | `cash`, `dollars`, `cost` | Currency amount (market orders) |
| `percentEquity` | `percent_equity`, `equityPercent` | % of account equity |
| `riskPercent` | `risk_percent` | % of equity at risk; needs a stop and a `price` |
| `orderType` | `order_type`, `type` | `market` (default) `limit` `stop` `stop_limit` `trailing_stop` |
| `limitPrice` | `limit_price`, `limit` | Required for limit / stop_limit |
| `stopPrice` | `stop_price`, `stop` | Required for stop / stop_limit |
| `trailAmount` / `trailPercent` | `trail_amount` / `trail_percent` | For trailing_stop |
| `timeInForce` | `time_in_force`, `tif` | `day` (default) `gtc` `ioc` `fok` |
| `takeProfit` | `take_profit`, `tp` | Bracket take-profit price |
| `stopLoss` | `stop_loss`, `sl` | Bracket stop-loss price |
| `stopLossLimit` | `stop_loss_limit` | Makes the stop-loss leg a stop-limit |
| `price` | `referencePrice`, `close` | The sender's price. Used for sizing math and simulator fills; never sent to a broker as an order price |
| `account` | `accountId` | Route to a specific configured account |
| `signalId` | `signal_id`, `id`, `alertId` | **Idempotency key.** The broker sees it as the client order id; resending the same id can never create a second order |
| `comment` | `message`, `note` | Free text, kept in the flight recorder |

Exactly one sizing field applies, in priority order quantity → notional → percentEquity → riskPercent; the endpoint's `defaults.sizing` fills in when none is sent.

## TradingView recipes

Alert on a symbol, fixed size:

```json
{ "action": "buy", "symbol": "{{ticker}}", "quantity": 1, "price": "{{close}}", "signalId": "{{timenow}}" }
```

Strategy alerts (order fills):

```json
{
  "action": "{{strategy.order.action}}",
  "symbol": "{{ticker}}",
  "quantity": "{{strategy.order.contracts}}",
  "price": "{{close}}",
  "signalId": "{{strategy.order.id}}-{{timenow}}"
}
```

Risk-managed entry with brackets (simulator today):

```json
{
  "action": "buy", "symbol": "{{ticker}}", "riskPercent": 1,
  "price": "{{close}}", "stopLoss": "{{plot_0}}", "takeProfit": "{{plot_1}}"
}
```

## Plain text

`BUY 10 AAPL` · `buy 10 shares of AAPL` · `SELL AAPL` · `close NVDA` · `FLATTEN` · `buy 0.5 BTCUSD at 64250 limit`

## Reading the response

The webhook answers immediately with the record id and outcome:

```json
{ "id": "…", "status": "executed", "order": { "id": "…", "status": "filled", "filledAvgPrice": 100 } }
```

`status` is one of `executed` · `rejected` (a risk rule said no — `rejectedBy` names it) · `noop` (e.g. close with no position) · `parse_error` · `error`. The full story lives at `GET /api/signals/<id>` and in the dashboard.

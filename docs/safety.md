# The safety rails

The rails are the product. They are enforced by the engine — not suggested by the docs — and they ship ON: a config that neither sets a rail nor consciously loosens it **fails validation at startup** with a message naming the flag.

## The rails

| Rail | Config | Loosening flag | Behavior |
| --- | --- | --- | --- |
| Symbol allowlist | `risk.symbolAllowlist` | `allowAnySymbol: true` | Only trade what you told it to trade. Exits (`close`/`flatten`) are always allowed, on any symbol |
| Max position size | `risk.maxPositionSize` (`quantity` and/or `notional`) | `unlimitedPositionSize: true` | Checked on the *projected* position after the fill. Fails closed: a notional order with no reference price is rejected rather than waved through |
| Max daily loss | `risk.maxDailyLoss` | `noDailyLossLimit: true` | Day PnL = current equity − equity at the first order of the (endpoint-timezone) day. Once breached, only risk-reducing orders pass until tomorrow |
| Max orders/day | `risk.maxOrdersPerDay` (default 100) | — | Runaway-loop protection; counts executed orders per endpoint |
| Trading hours | `risk.tradingHours` | omit it | Timezone-aware windows. Exits are allowed outside hours |
| Duplicate protection | `risk.dedupeWindowSec` (default 10) | `0` | The identical signal inside the window is dropped — the same alert firing twice cannot double your position. Belt-and-suspenders with `signalId` idempotency at the broker |
| Cooldown | `risk.cooldownSec` (default 0) | — | Minimum seconds between orders on the same symbol; exits exempt |
| **Kill switch** | — | — | One action stops all order placement everywhere — webhooks, MCP, replays, exits included. Persisted: it survives restarts and only an explicit resume clears it |

Every decision — pass, reject, or skip — is recorded with its reason in the flight recorder. When a signal is rejected you will always know which rule said no and why.

## The kill switch

Three ways to throw it:

- The dashboard button (front and center).
- `POST /api/kill {"on": true, "reason": "…"}`.
- A webhook signal: `{"action": "kill"}` — so your platform's own automation can pull the cord.
- An MCP agent may **always** turn it ON (stopping is safe). Turning it OFF via MCP additionally requires `mcp.allowTrading: true`.

While killed, nothing places orders — deliberately including exits, because "something is wrong, stop touching my account" has to mean exactly that. To get out of positions: resume, then flatten.

## Exits are privileged

`close` and `flatten` intents are `reduceOnly`: they skip the allowlist, trading hours, cooldown, and the daily-loss cutoff (each skip recorded), because refusing to let someone exit is how software blows up accounts. They still respect the kill switch and duplicate protection.

## Webhook security

- The URL itself carries a secret token (min 16 chars; `init` generates 48-hex ones). Compared timing-safe. Unknown tokens get an anonymous 404.
- Optional per-endpoint HMAC: set `hmacSecret` and send `X-Signature: sha256=<hex hmac of raw body>` — for senders that support it (TradingView doesn't; the token URL is the TradingView-compatible layer).
- The dashboard/API require a Bearer token (`server.dashboardToken`); without one configured they answer loopback callers only.
- A second, scoped `server.agentToken` exists to hand to agents and integrations: read-only by default (`agentTokenScope: "read"`), it can inspect everything and turn the kill switch ON but never trade; the operator may widen it to `"trade"`. Rotate the value to revoke. The dashboard token never needs to leave your hands.
- Payload bodies are capped (256 KB) and stored truncated at 64 KB.

## Live trading

Alpaca paper keys and Tradier sandbox tokens connect without ceremony. A **live** Alpaca key connects only when your account config carries broker-sdk's exact acknowledgement sentence, verbatim:

```json
{
  "id": "real",
  "broker": "alpaca",
  "credentials": { "apiKey": "${ALPACA_LIVE_KEY}", "apiSecret": "${ALPACA_LIVE_SECRET}" },
  "acknowledgeLiveTrading": "I understand this places real orders with real money"
}
```

It is never a boolean, never a default, and no tool writes it for you (`trade-relay init` will not generate it): typing the sentence into your own config is the opt-in. On top of it, the relay keeps its own posture for live accounts: the rails above stay mandatory per endpoint, the startup log prints a LIVE warning, replay refuses live targets outright, and the dashboard marks the account in red. Tradier stays sandbox-pinned by the SDK itself, so live Tradier orders are impossible by construction.

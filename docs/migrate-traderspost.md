# Migrating from TradersPost

**You change one thing: the URL in your alert. Your payloads keep working.**

trade-relay understands TradersPost's webhook format natively — `ticker`, `action` (`buy`/`sell`/`exit`/`cancel`), `sentiment` (`bullish`/`bearish`/`flat`), `price`, `quantity`, and object-shaped `takeProfit`/`stopLoss` — with the same semantics:

- `action: "exit"` or `sentiment: "flat"` → close the position
- `action: "cancel"` → cancel open orders for the ticker
- `takeProfit: { "limitPrice": 200 }` / `stopLoss: { "stopPrice": 170 }` → bracket legs

## Steps

1. Deploy trade-relay ([deploy.md](deploy.md)) and note your webhook URL:
   `https://<your-deployment>/webhook/<WEBHOOK_TOKEN>`
2. In your strategy's config, set the endpoint's `risk` to mirror what you had
   (allowlist, position cap, loss limit — they're mandatory here, not add-ons).
3. In each TradingView alert, replace the TradersPost webhook URL with yours.
   **Leave the alert message exactly as it is.**
4. Fire a test alert; open the dashboard and watch the story chain.

## What maps to what

| TradersPost | trade-relay |
| --- | --- |
| Strategy connected to a broker | An `endpoint` routed to an `account` |
| Paper trading | The built-in simulator, or an Alpaca paper account |
| Signal history | The flight recorder (every rule decision included, stored in *your* SQLite file) |
| Per-strategy risk settings | `risk` block per endpoint — on by default |
| Monthly subscription | `rm` your subscription; this is MIT-licensed |

## Honest differences

- Real-broker coverage is currently Alpaca (paper, and live behind an explicit acknowledgement) plus the Tradier sandbox, via [`@luxalgo/broker-sdk`](https://github.com/LuxAlgo/broker-sdk); more brokers arrive as its write layer rolls out, and the simulator carries the full order vocabulary meanwhile.
- You host it (that's the point — your keys never leave your infrastructure).

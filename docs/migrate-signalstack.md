# Migrating from SignalStack

**Change the URL. Keep the alert.**

SignalStack-style payloads work as-is:

- JSON: `{ "action": "buy", "symbol": "AAPL", "quantity": 10 }`
- Plain text, straight from an alert box:
  - `BUY 10 AAPL`
  - `buy 10 shares of AAPL`
  - `SELL AAPL`
  - `close NVDA`
  - `FLATTEN`

## Steps

1. Deploy trade-relay ([deploy.md](deploy.md)).
2. Configure your endpoint's `risk` block (allowlist, position cap, daily loss — mandatory).
3. Swap the SignalStack URL in your alerts for `https://<your-deployment>/webhook/<WEBHOOK_TOKEN>`.
4. Fire a test; watch it in the flight recorder.

## The economics

SignalStack bills per signal. trade-relay is free per signal, free per month, MIT-licensed, and runs on a $0–$5 host. There is no catch: it makes us zero dollars by design, and there is no telemetry to be the hidden price.

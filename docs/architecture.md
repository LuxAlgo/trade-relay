# Architecture

```
TradingView / Zapier / curl / MCP agent
        │  POST /webhook/<token>        (or MCP place_order)
        ▼
   ┌─────────┐   ┌──────────┐   ┌──────────────┐   ┌──────────┐
   │ parsers  │ → │  sizing  │ → │  risk engine │ → │  broker  │
   │ auto:    │   │ qty · $  │   │ 8 rails, all │   │  ports   │
   │ native · │   │ %equity ·│   │ decisions    │   │ sdk ·    │
   │ TP · SS ·│   │ risk %   │   │ recorded     │   │ simulator│
   │ text     │   └──────────┘   └──────────────┘   └──────────┘
   └─────────┘                                            │
        │                 every step, either way          ▼
        └────────────────────► flight recorder ◄─── fills/answers
                              (SQLite, local)
                                     │
                     dashboard · REST API · MCP · replay
                                     │
                          tape: fills per symbol → chart
```

## Design decisions

- **One long-running process.** The dedupe window, daily-loss counter, kill switch, and SQLite log are stateful; a persistent Node server is the honest reference architecture. Storage sits behind a small driver interface (`sqlite` and `memory` today) so a serverless-friendly driver can come later without touching the engine.
- **All broker connectivity lives upstream in [`@luxalgo/broker-sdk`](https://github.com/LuxAlgo/broker-sdk).** trade-relay never speaks a broker's REST dialect. The `BrokerPort` seam has two implementations: the SDK port (real accounts — Alpaca paper today, growing with the SDK's write layer) and the simulator (the full order vocabulary: stops, stop-limits, trailing stops, OCO brackets). What the SDK can't express is refused with a pointer to [the upstream proposal](broker-sdk-proposal.md) — never emulated against a real account.
- **The engine is pure-ish and injectable.** Risk evaluation is a pure function of explicit inputs; the engine takes storage/ports/notifier/clock as dependencies. That's why the whole pipeline — including brackets triggering on later prices — runs in unit tests with zero network.
- **Bad signals are data, not exceptions.** Parse failures, rule rejections, and broker errors all end as recorded stories with reasons, not 500s and log lines.
- **Zero runtime dependencies beyond four:** `@luxalgo/broker-sdk`, `@modelcontextprotocol/sdk`, `zod`, and `@luxalgo/vela` for the dashboard's chart. HTTP is `node:http`, storage is `node:sqlite`, the dashboard is one server-rendered page with no build step, no CDN, no external requests — Vela's browser bundle is copied into `dist/` at build time and served from the relay's own origin, only when the Tape panel is opened. The one deliberate exception: for a crypto pair whose account has no bars, the Tape may ask Vela's bundled keyless Binance/Coinbase providers for public candles — from the browser, labelled as such, and falling back to the fill path when unreachable.
- **Bars for the tape come from the port, never from the relay.** The simulator draws its own deterministic bars from the prices its signals carried (it is the price process); real brokers get bars from `@luxalgo/broker-sdk`'s `fetchBars` (Alpaca and Tradier, detected at runtime); otherwise the tape says `bars: null` and charts the fill path.

## Source map

```
src/
  parsers/        native · traderspost · text · auto-detection
  risk.ts         the rails (pure)
  sizing.ts       qty / notional / %equity / risk% (pure)
  brokers/        port seam · sdk-port (broker-sdk) · simulator · watch readers
  storage/        driver interface · sqlite · memory
  engine.ts       the pipeline; replay; kill/pause/flatten
  server.ts       webhook inlet · REST API · the bundled chart library (node:http)
  dashboard.ts    the flight-recorder UI (one HTML string) · the Tape panel
  tape.ts         fills per symbol from the recorder · FIFO pairs · bars from the port (pure)
  brokers/simulated-bars.ts  the simulator's own 1m bars, anchored on the prices it saw (pure)
  vela-asset.ts   where the shipped Vela bundle lives
  mcp.ts          the agent surface
  notify.ts       discord/slack/telegram/webhook, fire-and-forget
  config.ts       zod schema; rails-on-by-default validation; ${ENV} interpolation
  cli.ts          init · start · mcp · simulate
```

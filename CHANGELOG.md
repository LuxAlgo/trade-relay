# Changelog

All notable changes to trade-relay are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

Initial public release.

- Webhook inlet with token URLs and optional HMAC signatures
- Parsers: native payload, TradersPost-compatible payloads, SignalStack-style JSON and plain text, with automatic format detection
- Risk engine with rails on by default: symbol allowlist, max position size, max daily loss, max orders per day, trading hours, duplicate-signal protection, per-symbol cooldown, persistent global kill switch
- Sizing modes: quantity, notional, percent of equity, risk percent
- Broker connectivity via @luxalgo/broker-sdk: Alpaca (paper, and live behind the SDK's acknowledgement sentence), Tradier sandbox, and a built-in simulator with the full order vocabulary (stops, stop-limits, trailing stops, OCO brackets)
- Watch-only portfolio accounts over the broker-sdk read layer
- Flight recorder on node:sqlite with a local dashboard and one-click replay
- Per-account trade stats (realized PnL, win rate, closed round trips) on the dashboard cards, REST API, and MCP, computed by broker-sdk's stats engine
- Fills on the tape: a dashboard Tape panel that charts where each symbol's orders filled (buy and sell markers with sizes, dashed entry-to-exit lines with realized P&L from FIFO pairs, click-through to the signal's story), drawn by Vela (@luxalgo/vela, Apache-2.0) and backed by `GET /api/tape` and `GET /api/tape/:symbol`. Bars come from the broker port when one can provide them, otherwise the chart draws the fill path only; nothing is fabricated. Vela's bundle ships inside the package and is served from the relay's own origin at `GET /vela.global.min.js`, loaded only when the panel is opened
- MCP server for AI agents: read-only by default, trading gated behind mcp.allowTrading, all agent orders pass the same risk rails
- Scoped agent token for hosted agents and integrations: a second revocable API key, read-only by default with an explicit "trade" opt-in; any scope may turn the kill switch on, only trade scope may turn it off
- Outbound notifications: Discord, Slack, Telegram, generic webhook
- CLI (init, start, mcp, simulate), Docker image, docker compose, Railway template

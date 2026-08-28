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
- MCP server for AI agents: read-only by default, trading gated behind mcp.allowTrading, all agent orders pass the same risk rails
- Outbound notifications: Discord, Slack, Telegram, generic webhook
- CLI (init, start, mcp, simulate), Docker image, docker compose, Railway template

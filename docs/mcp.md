# The MCP surface (AI agents)

trade-relay doubles as an MCP server: `trade-relay mcp` speaks the Model Context Protocol on stdio against the same config and flight recorder as the running relay.

```jsonc
// Claude Desktop / Claude Code / any MCP client
{
  "mcpServers": {
    "trade-relay": { "command": "npx", "args": ["trade-relay", "mcp"], "cwd": "/path/to/your/relay" }
  }
}
```

## The safety model

- **Read-only by default.** Out of the box an agent can inspect state and the flight recorder, and nothing else.
- **Trading is a human-set switch.** Only `mcp.allowTrading: true` in `trade-relay.config.json` enables order tools. An agent cannot enable it, and the tools tell the agent so.
- **No special paths.** An agent's `place_order` builds a native payload and feeds it through the *identical* pipeline as a TradingView webhook: allowlist, position caps, loss cutoff, dedupe, hours — all of it — and the attempt lands in the flight recorder either way.
- **One deliberate asymmetry:** an agent may always throw the kill switch ON (stopping is safe). Turning it OFF requires `allowTrading`.

## Tools

| Tool | Needs `allowTrading` | What it does |
| --- | --- | --- |
| `get_status` | no | Kill switch, paused endpoints, accounts, endpoints and their risk configs |
| `get_accounts` | no | Equity, cash, positions per account (+ watch-only snapshots) |
| `list_orders` | no | Orders at the broker |
| `list_signals` | no | Recent flight-recorder entries |
| `get_signal_story` | no | The full story of one signal — the "why was this rejected?" tool |
| `kill_switch` on | no | Stop everything |
| `kill_switch` off | **yes** | Resume trading |
| `place_order` | **yes** | Order through the full risk pipeline |
| `flatten` | **yes** | Cancel everything, close everything |
| `replay_signal` | **yes** | Re-run a captured payload (never against a live account) |

## What this is for

- *"Connect to my relay and tell me why the 2:30pm signal didn't fire."* → `get_signal_story`
- *"Watch my paper account and flatten if I'm down more than $300."* → `get_accounts` + `flatten`
- *"Buy 5 AAPL on paper."* → `place_order`, which the allowlist and caps still police.

The incumbent relays were built for TradingView alerts. This one is built for TradingView alerts **and** for agents — same rails for both.

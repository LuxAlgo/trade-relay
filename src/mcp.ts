import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { BrokerConnection } from "@luxalgo/broker-sdk";
import type { RelayConfig } from "./config.js";
import type { Engine } from "./engine.js";
import type { StorageDriver } from "./storage/driver.js";
import { VERSION } from "./version.js";

/*
  The agent surface. Reading is always available; trading exists only when
  the human set mcp.allowTrading: true in the config — an agent cannot grant
  itself the permission. And when trading is on, an agent gets zero special
  paths: place_order builds a native payload and feeds it through the same
  pipeline as a TradingView webhook, so every risk rail applies and every
  agent order lands in the flight recorder like any other signal.

  One deliberate asymmetry: an agent may always turn the kill switch ON
  (stopping trading is safe); turning it OFF requires allowTrading.
*/

export type McpDeps = {
  config: RelayConfig;
  engine: Engine;
  storage: StorageDriver;
  watchReaders: Map<string, BrokerConnection>;
};

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

const refusal = () =>
  json({
    error:
      "Trading via MCP is disabled. The human operator must set mcp.allowTrading: true in trade-relay.config.json — an agent cannot enable it.",
  });

export const createMcpServer = (deps: McpDeps): McpServer => {
  const { config, engine, storage, watchReaders } = deps;
  const allowTrading = config.mcp.allowTrading;
  const defaultEndpoint = config.endpoints[0]!.id;

  const server = new McpServer({ name: "trade-relay", version: VERSION });

  server.tool(
    "get_status",
    "The relay's state: kill switch, paused endpoints, configured endpoints and accounts, whether MCP trading is enabled.",
    {},
    async () =>
      json({
        version: VERSION,
        mcpTradingEnabled: allowTrading,
        ...engine.status(),
        endpoints: config.endpoints.map((endpoint) => ({
          id: endpoint.id,
          parser: endpoint.parser,
          account: endpoint.account,
          risk: endpoint.risk,
        })),
      }),
  );

  server.tool(
    "get_accounts",
    "Equity, cash, and open positions for every execute account, plus snapshots of watch-only accounts.",
    {},
    async () => {
      const accounts: unknown[] = [];
      for (const port of engine.ports.values()) {
        try {
          const [equity, positions] = await Promise.all([port.getEquity(), port.getPositions()]);
          accounts.push({ id: port.id, broker: port.broker, environment: port.environment, ...equity, positions });
        } catch (error) {
          accounts.push({ id: port.id, broker: port.broker, error: (error as Error).message });
        }
      }
      for (const [id, reader] of watchReaders) {
        try {
          accounts.push({ id, broker: reader.broker, mode: "watch", snapshot: await reader.fetchSnapshot() });
        } catch (error) {
          accounts.push({ id, broker: reader.broker, mode: "watch", error: (error as Error).message });
        }
      }
      return json(accounts);
    },
  );

  server.tool(
    "list_orders",
    "Orders at the broker for one execute account.",
    {
      account: z.string().optional().describe("Execute account id; defaults to the first endpoint's account"),
      status: z.enum(["open", "closed", "all"]).optional().describe("Default: all"),
    },
    async ({ account, status }) => {
      const accountId = account ?? config.endpoints[0]!.account;
      const port = engine.ports.get(accountId);
      if (!port) return json({ error: `unknown execute account "${accountId}"` });
      return json(await port.listOrders({ status: status ?? "all", limit: 200 }));
    },
  );

  server.tool(
    "list_signals",
    "Recent flight-recorder entries (newest first): what arrived, how it parsed, what the rules decided, what executed.",
    {
      limit: z.number().int().positive().max(200).optional().describe("Default 25"),
      status: z.enum(["received", "parse_error", "rejected", "executed", "noop", "error"]).optional(),
      endpoint: z.string().optional(),
    },
    async ({ limit, status, endpoint }) =>
      json(
        storage
          .listSignals({ limit: limit ?? 25, ...(status ? { status } : {}), ...(endpoint ? { endpointId: endpoint } : {}) })
          .map((record) => ({
            id: record.id,
            receivedAt: record.receivedAt,
            endpointId: record.endpointId,
            status: record.status,
            signal: record.signal,
            rejectedBy: record.decisions?.find((decision) => decision.outcome === "reject"),
            order: record.order ? { id: record.order.id, status: record.order.status, filledAvgPrice: record.order.filledAvgPrice } : undefined,
            error: record.error,
          })),
      ),
  );

  server.tool(
    "get_signal_story",
    "The complete story of one signal by id: raw payload → parsed meaning → every risk decision with its reason → order sent → broker's answer. This is the tool for 'why did my signal get rejected?'.",
    { id: z.string().describe("Signal id from list_signals") },
    async ({ id }) => json(storage.getSignal(id) ?? { error: `no signal ${id}` }),
  );

  server.tool(
    "kill_switch",
    "Turn the global kill switch ON (always allowed — stopping is safe) or OFF (requires mcp.allowTrading).",
    {
      on: z.boolean().describe("true stops all order placement everywhere"),
      reason: z.string().optional(),
    },
    async ({ on, reason }) => {
      if (!on && !allowTrading) return refusal();
      engine.setKillSwitch(on, reason ?? "via MCP");
      return json(engine.status().killSwitch);
    },
  );

  server.tool(
    "place_order",
    allowTrading
      ? "Place an order THROUGH THE RELAY'S RISK RAILS — identical path to a TradingView webhook: the endpoint's allowlist, position caps, loss cutoff, dedupe and hours all apply, and the attempt lands in the flight recorder either way."
      : "Disabled: mcp.allowTrading is false in the relay config. Only the human operator can enable it.",
    {
      action: z.enum(["buy", "sell", "close"]),
      symbol: z.string(),
      quantity: z.number().positive().optional(),
      notional: z.number().positive().optional().describe("Currency amount instead of quantity (market orders)"),
      orderType: z.enum(["market", "limit", "stop", "stop_limit", "trailing_stop"]).optional(),
      limitPrice: z.number().positive().optional(),
      stopPrice: z.number().positive().optional(),
      takeProfit: z.number().positive().optional().describe("Bracket take-profit price"),
      stopLoss: z.number().positive().optional().describe("Bracket stop-loss price"),
      price: z.number().positive().optional().describe("Reference price for sizing and simulator fills"),
      endpoint: z.string().optional().describe(`Endpoint whose risk config applies (default "${defaultEndpoint}")`),
      signalId: z.string().optional().describe("Idempotency key — reuse to avoid double orders"),
    },
    async ({ endpoint, ...payload }) => {
      if (!allowTrading) return refusal();
      const endpointId = endpoint ?? defaultEndpoint;
      const record = await engine.ingest(endpointId, JSON.stringify(payload), { sourceIp: "mcp" });
      return json(record);
    },
  );

  server.tool(
    "flatten",
    "Cancel every open order and close every position on one account (requires mcp.allowTrading).",
    { account: z.string().optional().describe("Execute account id; defaults to the first endpoint's account") },
    async ({ account }) => {
      if (!allowTrading) return refusal();
      return json(await engine.flattenAll(account ?? config.endpoints[0]!.account));
    },
  );

  server.tool(
    "replay_signal",
    "Re-run a captured payload through the whole pipeline (requires mcp.allowTrading). Replay never targets a live account.",
    {
      id: z.string().describe("Signal id from list_signals"),
      account: z.string().optional().describe("Route the replay to a different paper/simulator account"),
    },
    async ({ id, account }) => {
      if (!allowTrading) return refusal();
      return json(await engine.replay(id, { ...(account ? { accountOverride: account } : {}) }));
    },
  );

  return server;
};

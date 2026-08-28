import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { BrokerConnection } from "@luxalgo/broker-sdk";
import { computeTradeStats } from "@luxalgo/broker-sdk/stats";
import { tradeStatsForPort } from "./account-stats.js";
import type { RelayConfig } from "./config.js";
import type { Engine } from "./engine.js";
import type { StorageDriver } from "./storage/driver.js";
import type { SignalRecord } from "./types.js";
import { renderDashboard } from "./dashboard.js";

/*
  The HTTP surface, on node:http and nothing else.

  Three trust zones:
  - /webhook/<token>   — authenticated by the token in the path (plus
    optional HMAC of the raw body). This is what TradingView calls.
  - /api/*             — the dashboard's data plane, Bearer-token protected.
    With no dashboardToken configured, it answers loopback callers only.
  - /  and /health     — the dashboard shell and liveness probe; no data.
*/

export type ServerDeps = {
  config: RelayConfig;
  engine: Engine;
  storage: StorageDriver;
  watchReaders: Map<string, BrokerConnection>;
  version: string;
};

const MAX_BODY_BYTES = 262_144;

const readBody = (request: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const json = (response: ServerResponse, status: number, data: unknown): void => {
  const body = JSON.stringify(data);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
};

const equalSecret = (candidate: string, actual: string): boolean => {
  const a = Buffer.from(candidate);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
};

const summarize = (record: SignalRecord) => ({
  id: record.id,
  status: record.status,
  ...(record.error ? { error: record.error } : {}),
  ...(record.order ? { order: { id: record.order.id, status: record.order.status, filledAvgPrice: record.order.filledAvgPrice } } : {}),
  ...(record.decisions ? { rejectedBy: record.decisions.find((d) => d.outcome === "reject")?.rule } : {}),
});

export const createRelayServer = (deps: ServerDeps): Server => {
  const { config, engine, storage, watchReaders, version } = deps;
  const startedAt = Date.now();

  const isLoopback = (request: IncomingMessage): boolean => {
    const address = request.socket.remoteAddress ?? "";
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  };

  const sourceIp = (request: IncomingMessage): string => {
    if (config.server.trustProxyHeader) {
      const header = request.headers["x-forwarded-for"];
      const first = (Array.isArray(header) ? header[0] : header)?.split(",")[0]?.trim();
      if (first) return first;
    }
    return request.socket.remoteAddress ?? "unknown";
  };

  const apiAuthorized = (request: IncomingMessage): boolean => {
    const token = config.server.dashboardToken;
    if (!token) return isLoopback(request);
    const header = request.headers.authorization ?? "";
    return header.startsWith("Bearer ") && equalSecret(header.slice(7), token);
  };

  const handleWebhook = async (request: IncomingMessage, response: ServerResponse, token: string): Promise<void> => {
    const endpoint = config.endpoints.find((candidate) => equalSecret(token, candidate.token));
    if (!endpoint) {
      json(response, 404, { error: "not found" });
      return;
    }
    const rawBody = await readBody(request);
    if (endpoint.hmacSecret) {
      const header = request.headers["x-signature"];
      const signature = (Array.isArray(header) ? header[0] : header)?.replace(/^sha256=/, "") ?? "";
      const expected = createHmac("sha256", endpoint.hmacSecret).update(rawBody).digest("hex");
      if (!equalSecret(signature, expected)) {
        json(response, 401, { error: "bad signature" });
        return;
      }
    }
    const record = await engine.ingest(endpoint.id, rawBody, { sourceIp: sourceIp(request) });
    json(response, record.status === "error" ? 500 : 200, summarize(record));
  };

  const handleApi = async (request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> => {
    if (!apiAuthorized(request)) {
      json(response, 401, { error: "unauthorized — send Authorization: Bearer <dashboardToken>" });
      return;
    }
    const path = url.pathname;
    const method = request.method ?? "GET";

    if (method === "GET" && path === "/api/status") {
      json(response, 200, {
        version,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        ...engine.status(),
        endpoints: config.endpoints.map((endpoint) => ({ id: endpoint.id, parser: endpoint.parser, account: endpoint.account })),
      });
      return;
    }

    if (method === "GET" && path === "/api/signals") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 500);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const status = url.searchParams.get("status") as SignalRecord["status"] | null;
      const endpointId = url.searchParams.get("endpoint");
      json(
        response,
        200,
        storage.listSignals({
          limit,
          offset,
          ...(status ? { status } : {}),
          ...(endpointId ? { endpointId } : {}),
        }),
      );
      return;
    }

    const signalMatch = path.match(/^\/api\/signals\/([0-9a-f-]+)$/);
    if (method === "GET" && signalMatch) {
      const record = storage.getSignal(signalMatch[1]!);
      if (!record) json(response, 404, { error: "no such signal" });
      else json(response, 200, record);
      return;
    }

    const replayMatch = path.match(/^\/api\/signals\/([0-9a-f-]+)\/replay$/);
    if (method === "POST" && replayMatch) {
      const body = await readBody(request);
      const options = body ? (JSON.parse(body) as { account?: string }) : {};
      const record = await engine.replay(replayMatch[1]!, {
        ...(options.account ? { accountOverride: options.account } : {}),
      });
      json(response, 200, record);
      return;
    }

    if (method === "GET" && path === "/api/accounts") {
      const accounts: unknown[] = [];
      for (const port of engine.ports.values()) {
        try {
          const [equity, positions, stats] = await Promise.all([
            port.getEquity(),
            port.getPositions(),
            tradeStatsForPort(port),
          ]);
          accounts.push({
            id: port.id,
            broker: port.broker,
            environment: port.environment,
            mode: "execute",
            ...equity,
            positions,
            ...(stats ? { stats } : {}),
          });
        } catch (error) {
          accounts.push({ id: port.id, broker: port.broker, environment: port.environment, mode: "execute", error: (error as Error).message });
        }
      }
      for (const [id, reader] of watchReaders) {
        try {
          const snapshot = await reader.fetchSnapshot();
          const stats = computeTradeStats(snapshot.accounts.flatMap((account) => account.trades));
          accounts.push({
            id,
            broker: reader.broker,
            mode: "watch",
            accounts: snapshot.accounts,
            ...(stats && stats.closedTrades > 0
              ? { stats: { closedTrades: stats.closedTrades, wins: stats.wins, losses: stats.losses, winRate: stats.winRate, realizedPnl: Number(stats.realizedPnl.toFixed(2)) } }
              : {}),
          });
        } catch (error) {
          accounts.push({ id, broker: reader.broker, mode: "watch", error: (error as Error).message });
        }
      }
      json(response, 200, accounts);
      return;
    }

    if (method === "GET" && path === "/api/orders") {
      const accountId = url.searchParams.get("account") ?? config.endpoints[0]?.account ?? "";
      const port = engine.ports.get(accountId);
      if (!port) {
        json(response, 404, { error: `unknown execute account "${accountId}"` });
        return;
      }
      const status = (url.searchParams.get("status") ?? "all") as "open" | "closed" | "all";
      json(response, 200, await port.listOrders({ status, limit: 200 }));
      return;
    }

    if (method === "POST" && path === "/api/kill") {
      const body = JSON.parse((await readBody(request)) || "{}") as { on?: boolean; reason?: string };
      engine.setKillSwitch(body.on ?? true, body.reason ?? "dashboard");
      json(response, 200, engine.status().killSwitch);
      return;
    }

    if (method === "POST" && path === "/api/pause") {
      const body = JSON.parse((await readBody(request)) || "{}") as { endpoint?: string; paused?: boolean };
      if (!body.endpoint || !config.endpoints.some((endpoint) => endpoint.id === body.endpoint)) {
        json(response, 400, { error: "unknown endpoint" });
        return;
      }
      engine.setPaused(body.endpoint, body.paused ?? true);
      json(response, 200, { ok: true });
      return;
    }

    if (method === "POST" && path === "/api/flatten") {
      const body = JSON.parse((await readBody(request)) || "{}") as { account?: string };
      const accountId = body.account ?? config.endpoints[0]?.account ?? "";
      json(response, 200, await engine.flattenAll(accountId));
      return;
    }

    if (method === "GET" && path === "/api/events") {
      json(response, 200, storage.listEvents(Math.min(Number(url.searchParams.get("limit") ?? 50), 500)));
      return;
    }

    json(response, 404, { error: "not found" });
  };

  return createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const route = async (): Promise<void> => {
      if (request.method === "POST" && url.pathname.startsWith("/webhook/")) {
        await handleWebhook(request, response, decodeURIComponent(url.pathname.slice("/webhook/".length)));
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        await handleApi(request, response, url);
        return;
      }
      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, { ok: true, version });
        return;
      }
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const html = renderDashboard(version);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }
      json(response, 404, { error: "not found" });
    };
    route().catch((error: unknown) => {
      if (!response.headersSent) json(response, 500, { error: (error as Error).message });
      else response.end();
    });
  });
};

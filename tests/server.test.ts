import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { createPorts } from "../src/brokers/index.js";
import { createEngine } from "../src/engine.js";
import { createMemoryStorage } from "../src/storage/memory.js";
import { createRelayServer } from "../src/server.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const HMAC_SECRET = "hmac-secret-hmac-secret";
const DASH = "dashboard-token-dashboard-token";

const config = parseConfig({
  server: { dashboardToken: DASH },
  storage: { driver: "memory" },
  accounts: [{ id: "sim", broker: "simulator", defaultFillPrice: 100 }],
  endpoints: [
    {
      id: "tv",
      token: TOKEN,
      account: "sim",
      risk: { symbolAllowlist: ["AAPL"], maxPositionSize: { quantity: 100 }, maxDailyLoss: 1000, dedupeWindowSec: 0 },
    },
    {
      id: "signed",
      token: `${TOKEN}ff`,
      hmacSecret: HMAC_SECRET,
      account: "sim",
      risk: { symbolAllowlist: ["AAPL"], maxPositionSize: { quantity: 100 }, maxDailyLoss: 1000, dedupeWindowSec: 0 },
    },
  ],
});

let server: Server;
let base: string;
let engine: ReturnType<typeof createEngine>;

beforeAll(async () => {
  const storage = createMemoryStorage();
  engine = createEngine({ config, storage, ports: createPorts(config), notifier: { send: () => {} } });
  server = createRelayServer({ config, engine, storage, watchReaders: new Map(), version: "test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const authed = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${DASH}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });

describe("webhook inlet", () => {
  it("executes a valid alert", async () => {
    const response = await post(`/webhook/${TOKEN}`, { action: "buy", symbol: "AAPL", quantity: 1, price: 100 });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; order?: { status: string } };
    expect(body.status).toBe("executed");
    expect(body.order?.status).toBe("filled");
  });

  it("404s an unknown token without leaking anything", async () => {
    const response = await post("/webhook/wrong-token-wrong-token", { action: "buy", symbol: "AAPL" });
    expect(response.status).toBe(404);
  });

  it("enforces HMAC when configured", async () => {
    const payload = JSON.stringify({ action: "buy", symbol: "AAPL", quantity: 1, price: 100 });
    const unsigned = await post(`/webhook/${TOKEN}ff`, payload);
    expect(unsigned.status).toBe(401);

    const signature = createHmac("sha256", HMAC_SECRET).update(payload).digest("hex");
    const signed = await post(`/webhook/${TOKEN}ff`, payload, { "X-Signature": `sha256=${signature}` });
    expect(signed.status).toBe(200);
  });

  it("returns 200 with rejection details for rejected signals", async () => {
    const response = await post(`/webhook/${TOKEN}`, { action: "buy", symbol: "GME", quantity: 1 });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; rejectedBy?: string };
    expect(body.status).toBe("rejected");
    expect(body.rejectedBy).toBe("symbolAllowlist");
  });
});

describe("dashboard API", () => {
  it("requires the bearer token", async () => {
    expect((await fetch(`${base}/api/status`)).status).toBe(401);
    const ok = await authed("/api/status");
    expect(ok.status).toBe(200);
    const status = (await ok.json()) as { killSwitch: { on: boolean }; accounts: unknown[] };
    expect(status.killSwitch.on).toBe(false);
    expect(status.accounts).toHaveLength(1);
  });

  it("lists signals and serves the full story", async () => {
    const list = (await (await authed("/api/signals?limit=5")).json()) as { id: string }[];
    expect(list.length).toBeGreaterThan(0);
    const story = (await (await authed(`/api/signals/${list[0]!.id}`)).json()) as { rawBody: string };
    expect(story.rawBody).toBeTruthy();
  });

  it("replays a signal", async () => {
    const list = (await (await authed("/api/signals?status=executed")).json()) as { id: string }[];
    const response = await authed(`/api/signals/${list[0]!.id}/replay`, { method: "POST", body: "{}" });
    expect(response.status).toBe(200);
    const replayed = (await response.json()) as { replayOf: string };
    expect(replayed.replayOf).toBe(list[0]!.id);
  });

  it("kill switch via API blocks the webhook until resumed", async () => {
    await authed("/api/kill", { method: "POST", body: JSON.stringify({ on: true, reason: "test" }) });
    const blocked = (await (await post(`/webhook/${TOKEN}`, { action: "buy", symbol: "AAPL", quantity: 1 })).json()) as { status: string };
    expect(blocked.status).toBe("rejected");
    await authed("/api/kill", { method: "POST", body: JSON.stringify({ on: false }) });
  });

  it("serves accounts and health", async () => {
    const accounts = (await (await authed("/api/accounts")).json()) as { id: string }[];
    expect(accounts[0]?.id).toBe("sim");
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("account stats appear after a round trip", async () => {
    await post(`/webhook/${TOKEN}`, { action: "buy", symbol: "AAPL", quantity: 2, price: 150, signalId: "stats-open" });
    await post(`/webhook/${TOKEN}`, { action: "close", symbol: "AAPL", price: 160, signalId: "stats-close" });
    const accounts = (await (await authed("/api/accounts")).json()) as { id: string; stats?: { closedTrades: number; realizedPnl: number } }[];
    const sim = accounts.find((account) => account.id === "sim");
    expect(sim?.stats).toBeDefined();
    expect(sim!.stats!.closedTrades).toBeGreaterThanOrEqual(1);
    expect(sim!.stats!.realizedPnl).toBeGreaterThan(0);
  });

  it("serves the dashboard shell", async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("flight recorder");
  });
});

describe("the bundled chart library", () => {
  it("serves Vela from this origin, immutable, as JavaScript", async () => {
    const response = await fetch(`${base}/vela.global.min.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const body = await response.text();
    expect(Number(response.headers.get("content-length"))).toBe(Buffer.byteLength(body));
    expect(body.startsWith("var Vela=")).toBe(true);
    expect(body).toContain("registerNativeIndicator");
    const head = await fetch(`${base}/vela.global.min.js`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe(response.headers.get("content-length"));
  });

  it("the dashboard loads Vela lazily and only from this origin", async () => {
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain('"/vela.global.min.js?v=');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/https?:\/\/[^"' ]*\.(js|css)/);
  });
});

describe("the tape API", () => {
  it("requires the bearer token", async () => {
    expect((await fetch(`${base}/api/tape`)).status).toBe(401);
    expect((await fetch(`${base}/api/tape/AAPL`)).status).toBe(401);
  });

  it("lists symbols with fills, then the fills, FIFO pairs and the simulator's bars", async () => {
    await post(`/webhook/${TOKEN}`, { action: "buy", symbol: "AAPL", quantity: 3, price: 120, signalId: "tape-open" });
    await post(`/webhook/${TOKEN}`, { action: "sell", symbol: "AAPL", quantity: 3, price: 126, signalId: "tape-close" });

    const summary = (await (await authed("/api/tape")).json()) as {
      symbols: { symbol: string; fills: number; sessions: string[]; accounts: string[] }[];
      accounts: string[];
    };
    const aapl = summary.symbols.find((entry) => entry.symbol === "AAPL");
    expect(aapl).toBeDefined();
    expect(aapl!.fills).toBeGreaterThanOrEqual(2);
    expect(aapl!.sessions.length).toBeGreaterThanOrEqual(1);
    expect(summary.accounts).toEqual(["sim"]);

    const tape = (await (await authed("/api/tape/AAPL")).json()) as {
      symbol: string;
      fills: { signalId: string; side: string; quantity: number; price: number; at: string; endpointId: string; accountId: string; orderId: string }[];
      pairs: { entrySignalId: string; exitSignalId: string; entryPrice: number; exitPrice: number; quantity: number; pnl: number }[];
      realizedPnl: number;
      bars: { time: number; open: number; high: number; low: number; close: number }[] | null;
      barsSource: string;
      barsTimeframe: string | null;
    };
    expect(tape.symbol).toBe("AAPL");
    const open = tape.fills.find((fill) => fill.price === 120 && fill.side === "buy");
    const close = tape.fills.find((fill) => fill.price === 126 && fill.side === "sell");
    expect(open).toMatchObject({ quantity: 3, endpointId: "tv", accountId: "sim" });
    expect(close).toBeDefined();
    expect(open!.orderId).toBeTruthy();
    expect(Date.parse(open!.at)).not.toBeNaN();
    // Every fill points back at a signal story.
    const story = await authed(`/api/signals/${open!.signalId}`);
    expect(story.status).toBe(200);
    const pair = tape.pairs.find((candidate) => candidate.exitSignalId === close!.signalId && candidate.entrySignalId === open!.signalId);
    expect(pair).toMatchObject({ quantity: 3, entryPrice: 120, exitPrice: 126, pnl: 18 });
    // The simulator is the price process, so its bars ride along and say so.
    expect(tape.barsSource).toBe("simulator");
    expect(tape.barsTimeframe).toBe("1m");
    expect(tape.bars!.length).toBeGreaterThan(0);
    const minute = 60_000;
    const openBar = tape.bars!.find((bar) => bar.time === Math.floor(Date.parse(open!.at) / minute) * minute)!;
    expect(openBar.low).toBeLessThanOrEqual(120);
    expect(openBar.high).toBeGreaterThanOrEqual(120);
    expect(tape.bars![0]!.time).toBeLessThanOrEqual(Date.parse(open!.at));
    expect(tape.bars![tape.bars!.length - 1]!.time).toBeGreaterThanOrEqual(Date.parse(close!.at));
  });

  it("answers bars: null, barsSource: none when the account's port has no bar capability", async () => {
    const port = engine.ports.get("sim")!;
    const getBars = port.getBars;
    delete (port as { getBars?: unknown }).getBars;
    try {
      const tape = (await (await authed("/api/tape/AAPL")).json()) as { bars: unknown; barsSource: string; barsTimeframe: unknown; fills: unknown[] };
      expect(tape.fills.length).toBeGreaterThan(0);
      expect(tape).toMatchObject({ bars: null, barsSource: "none", barsTimeframe: null });
    } finally {
      if (getBars) port.getBars = getBars;
    }
  });

  it("filters by range and account, and rejects a malformed range", async () => {
    const future = (await (await authed("/api/tape/AAPL?from=2999-01-01")).json()) as { fills: unknown[]; from: string };
    expect(future.fills).toEqual([]);
    expect(future.from).toBe("2999-01-01T00:00:00.000Z");
    const other = (await (await authed("/api/tape/AAPL?account=nope")).json()) as { fills: unknown[] };
    expect(other.fills).toEqual([]);
    expect((await authed("/api/tape/AAPL?from=yesterday")).status).toBe(400);
    const none = (await (await authed("/api/tape/ZZZZ")).json()) as { fills: unknown[]; pairs: unknown[]; realizedPnl: number };
    expect(none).toMatchObject({ fills: [], pairs: [], realizedPnl: 0 });
  });
});

import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { createPorts } from "../src/brokers/index.js";
import { createEngine } from "../src/engine.js";
import { createMemoryStorage } from "../src/storage/memory.js";
import { createRelayServer } from "../src/server.js";

const WEBHOOK = "0123456789abcdef0123456789abcdef";
const DASH = "dashboard-token-dashboard-token";
const AGENT = "agent-token-agent-token-agent";

const configFor = (scope: "read" | "trade") =>
  parseConfig({
    server: { dashboardToken: DASH, agentToken: AGENT, agentTokenScope: scope },
    storage: { driver: "memory" },
    accounts: [{ id: "sim", broker: "simulator", defaultFillPrice: 100 }],
    endpoints: [
      {
        id: "tv",
        token: WEBHOOK,
        account: "sim",
        risk: { symbolAllowlist: ["AAPL"], maxPositionSize: { quantity: 100 }, maxDailyLoss: 1000, dedupeWindowSec: 0 },
      },
    ],
  });

const boot = async (scope: "read" | "trade") => {
  const config = configFor(scope);
  const storage = createMemoryStorage();
  const engine = createEngine({ config, storage, ports: createPorts(config), notifier: { send: () => {} } });
  const server = createRelayServer({ config, engine, storage, watchReaders: new Map(), version: "test" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, engine, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

const call = (base: string, token: string, path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });

describe("agent token, read scope (the default)", () => {
  let base: string;
  let server: Server;

  beforeAll(async () => {
    const booted = await boot("read");
    base = booted.base;
    server = booted.server;
    await fetch(`${base}/webhook/${WEBHOOK}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "buy", symbol: "AAPL", quantity: 1, price: 100, signalId: "seed" }),
    });
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("can read everything", async () => {
    expect((await call(base, AGENT, "/api/status")).status).toBe(200);
    expect((await call(base, AGENT, "/api/accounts")).status).toBe(200);
    const signals = (await (await call(base, AGENT, "/api/signals")).json()) as { id: string }[];
    expect(signals.length).toBeGreaterThan(0);
    expect((await call(base, AGENT, `/api/signals/${signals[0]!.id}`)).status).toBe(200);
  });

  it("may turn the kill switch ON, but not OFF", async () => {
    const on = await call(base, AGENT, "/api/kill", { method: "POST", body: JSON.stringify({ on: true, reason: "agent" }) });
    expect(on.status).toBe(200);

    const off = await call(base, AGENT, "/api/kill", { method: "POST", body: JSON.stringify({ on: false }) });
    expect(off.status).toBe(403);

    // The master key resumes.
    expect((await call(base, DASH, "/api/kill", { method: "POST", body: JSON.stringify({ on: false }) })).status).toBe(200);
  });

  it("cannot trade: flatten, replay, resume are refused with the reason", async () => {
    const flatten = await call(base, AGENT, "/api/flatten", { method: "POST", body: "{}" });
    expect(flatten.status).toBe(403);
    expect(((await flatten.json()) as { error: string }).error).toContain("read-only");

    const signals = (await (await call(base, AGENT, "/api/signals?status=executed")).json()) as { id: string }[];
    expect((await call(base, AGENT, `/api/signals/${signals[0]!.id}/replay`, { method: "POST", body: "{}" })).status).toBe(403);

    expect((await call(base, AGENT, "/api/pause", { method: "POST", body: JSON.stringify({ endpoint: "tv", paused: false }) })).status).toBe(403);
    // Pausing (stopping) is allowed.
    expect((await call(base, AGENT, "/api/pause", { method: "POST", body: JSON.stringify({ endpoint: "tv", paused: true }) })).status).toBe(200);
    expect((await call(base, DASH, "/api/pause", { method: "POST", body: JSON.stringify({ endpoint: "tv", paused: false }) })).status).toBe(200);
  });

  it("a wrong token is still just unauthorized", async () => {
    expect((await call(base, "not-a-real-token-at-all", "/api/status")).status).toBe(401);
  });
});

describe("agent token, trade scope (operator opt-in)", () => {
  let base: string;
  let server: Server;

  beforeAll(async () => {
    const booted = await boot("trade");
    base = booted.base;
    server = booted.server;
    await fetch(`${base}/webhook/${WEBHOOK}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "buy", symbol: "AAPL", quantity: 1, price: 100, signalId: "seed" }),
    });
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("may flatten and resume", async () => {
    expect((await call(base, AGENT, "/api/flatten", { method: "POST", body: "{}" })).status).toBe(200);
    await call(base, AGENT, "/api/kill", { method: "POST", body: JSON.stringify({ on: true }) });
    expect((await call(base, AGENT, "/api/kill", { method: "POST", body: JSON.stringify({ on: false }) })).status).toBe(200);
  });
});

describe("config validation", () => {
  it("rejects an agent token equal to the dashboard token", () => {
    expect(() =>
      parseConfig({
        server: { dashboardToken: DASH, agentToken: DASH },
        accounts: [{ id: "sim", broker: "simulator" }],
        endpoints: [
          { id: "tv", token: WEBHOOK, account: "sim", risk: { symbolAllowlist: ["AAPL"], maxPositionSize: { quantity: 1 }, maxDailyLoss: 1 } },
        ],
      }),
    ).toThrow(/must differ/);
  });
});

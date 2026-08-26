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

beforeAll(async () => {
  const storage = createMemoryStorage();
  const engine = createEngine({ config, storage, ports: createPorts(config), notifier: { send: () => {} } });
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

  it("serves the dashboard shell", async () => {
    const response = await fetch(`${base}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("flight recorder");
  });
});

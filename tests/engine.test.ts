import { describe, expect, it } from "vitest";
import { parseConfig, type RelayConfig } from "../src/config.js";
import { createPorts } from "../src/brokers/index.js";
import { createEngine, type Engine } from "../src/engine.js";
import { createMemoryStorage } from "../src/storage/memory.js";
import type { NotifyEvent } from "../src/notify.js";

const makeConfig = (risk: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): RelayConfig =>
  parseConfig({
    storage: { driver: "memory" },
    accounts: [{ id: "sim", broker: "simulator", defaultFillPrice: 100 }],
    endpoints: [
      {
        id: "ep",
        token: "0123456789abcdef",
        account: "sim",
        risk: {
          symbolAllowlist: ["AAPL", "SPY"],
          maxPositionSize: { quantity: 100 },
          maxDailyLoss: 400,
          dedupeWindowSec: 10,
          ...risk,
        },
      },
    ],
    ...extra,
  });

const makeEngine = (config = makeConfig()): { engine: Engine; events: NotifyEvent[]; storage: ReturnType<typeof createMemoryStorage> } => {
  const events: NotifyEvent[] = [];
  const storage = createMemoryStorage();
  const engine = createEngine({
    config,
    storage,
    ports: createPorts(config),
    notifier: { send: (event) => events.push(event) },
  });
  return { engine, events, storage };
};

const buy = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ action: "buy", symbol: "AAPL", quantity: 10, price: 100, ...overrides });

describe("engine pipeline", () => {
  it("executes a clean buy and tells the whole story", async () => {
    const { engine, events } = makeEngine();
    const record = await engine.ingest("ep", buy({ signalId: "sig-1" }));

    expect(record.status).toBe("executed");
    expect(record.parser).toBe("trade-relay");
    expect(record.signal?.symbol).toBe("AAPL");
    expect(record.intent?.clientOrderId).toBe("sig-1");
    expect(record.decisions?.every((decision) => decision.outcome !== "reject")).toBe(true);
    expect(record.order?.status).toBe("filled");
    expect(record.order?.filledAvgPrice).toBe(100);
    expect(record.latencyMs).toBeGreaterThanOrEqual(0);
    expect(events.some((event) => event.type === "fill")).toBe(true);
  });

  it("rejects the identical signal fired twice inside the window", async () => {
    const { engine } = makeEngine();
    const first = await engine.ingest("ep", buy());
    expect(first.status).toBe("executed");

    const second = await engine.ingest("ep", buy());
    expect(second.status).toBe("rejected");
    expect(second.decisions?.find((decision) => decision.outcome === "reject")?.rule).toBe("duplicateSignal");
  });

  it("records allowlist rejections with the reason", async () => {
    const { engine, events } = makeEngine();
    const record = await engine.ingest("ep", buy({ symbol: "GME" }));
    expect(record.status).toBe("rejected");
    expect(record.decisions?.find((decision) => decision.outcome === "reject")).toMatchObject({
      rule: "symbolAllowlist",
      reason: expect.stringContaining("GME"),
    });
    expect(events.some((event) => event.type === "reject")).toBe(true);
  });

  it("close: noop when flat, closes the position (and its resting orders) when long", async () => {
    const { engine } = makeEngine();
    const flat = await engine.ingest("ep", JSON.stringify({ action: "close", symbol: "AAPL" }));
    expect(flat.status).toBe("noop");

    await engine.ingest("ep", buy({ takeProfit: 120, signalId: "entry" }));
    const port = engine.ports.get("sim")!;
    expect(await port.listOrders({ status: "open" })).toHaveLength(1); // the TP leg

    // A distinct signalId — an identical close payload inside the dedupe
    // window would (correctly) be dropped as a duplicate.
    const close = await engine.ingest("ep", JSON.stringify({ action: "close", symbol: "AAPL", signalId: "close-1" }));
    expect(close.status).toBe("executed");
    expect(close.intent?.reduceOnly).toBe(true);
    expect(close.order?.status).toBe("filled");
    expect(await port.getPositions()).toEqual([]);
    expect(await port.listOrders({ status: "open" })).toHaveLength(0);
  });

  it("kill signal stops everything until explicitly resumed", async () => {
    const { engine } = makeEngine();
    const kill = await engine.ingest("ep", JSON.stringify({ action: "kill" }));
    expect(kill.status).toBe("executed");
    expect(engine.status().killSwitch.on).toBe(true);

    const blocked = await engine.ingest("ep", buy());
    expect(blocked.status).toBe("rejected");
    expect(blocked.decisions?.[0]).toMatchObject({ rule: "killSwitch", outcome: "reject" });

    engine.setKillSwitch(false, "test");
    const allowed = await engine.ingest("ep", buy({ signalId: "after-resume" }));
    expect(allowed.status).toBe("executed");
  });

  it("daily loss cutoff: blocks new risk after drawdown, still lets you exit", async () => {
    const { engine } = makeEngine();
    await engine.ingest("ep", buy({ signalId: "open" })); // 10 AAPL @ 100, day start equity 100k

    // Price collapses to 50 — the signal carries the price, gets rejected on
    // the loss rail, but the flight recorder keeps the story.
    const rejected = await engine.ingest("ep", buy({ price: 50, signalId: "add-more" }));
    expect(rejected.status).toBe("rejected");
    expect(rejected.decisions?.find((decision) => decision.outcome === "reject")?.rule).toBe("maxDailyLoss");

    const exit = await engine.ingest("ep", JSON.stringify({ action: "close", symbol: "AAPL" }));
    expect(exit.status).toBe("executed");
  });

  it("caps orders per day", async () => {
    const { engine } = makeEngine(makeConfig({ maxOrdersPerDay: 1, dedupeWindowSec: 0 }));
    expect((await engine.ingest("ep", buy({ signalId: "a" }))).status).toBe("executed");
    const capped = await engine.ingest("ep", buy({ signalId: "b" }));
    expect(capped.status).toBe("rejected");
    expect(capped.decisions?.find((decision) => decision.outcome === "reject")?.rule).toBe("maxOrdersPerDay");
  });

  it("flatten cancels orders and closes every position", async () => {
    const { engine, events } = makeEngine(makeConfig({ dedupeWindowSec: 0 }));
    await engine.ingest("ep", buy({ signalId: "a" }));
    await engine.ingest("ep", buy({ symbol: "SPY", quantity: 5, price: 500, signalId: "b" }));

    const record = await engine.ingest("ep", JSON.stringify({ action: "flatten" }));
    expect(record.status).toBe("executed");
    expect(record.orders).toHaveLength(2);
    expect(await engine.ports.get("sim")!.getPositions()).toEqual([]);
    expect(events.some((event) => event.type === "flatten")).toBe(true);
  });

  it("a later price update triggers resting bracket legs and records them", async () => {
    const { engine } = makeEngine(makeConfig({ dedupeWindowSec: 0 }));
    await engine.ingest("ep", buy({ takeProfit: 110, signalId: "entry" }));

    // Any signal carrying a price ticks the simulator — even one that ends
    // as a noop. The TP leg fires and lands on the record.
    const later = await engine.ingest("ep", JSON.stringify({ action: "close", symbol: "AAPL", price: 111 }));
    expect(later.orders).toHaveLength(1);
    expect(later.orders?.[0]?.status).toBe("filled");
    expect(later.status).toBe("noop"); // the TP already closed the position
  });

  it("replay re-runs a captured payload and links the records", async () => {
    const { engine, storage } = makeEngine(makeConfig({ dedupeWindowSec: 0 }));
    const original = await engine.ingest("ep", buy({ signalId: "orig" }));
    const replayed = await engine.replay(original.id);
    expect(replayed.replayOf).toBe(original.id);
    expect(replayed.status).toBe("executed");
    expect(storage.getSignal(replayed.id)?.replayOf).toBe(original.id);
  });

  it("surfaces malformed orders and unknown endpoints as recorded errors", async () => {
    const { engine } = makeEngine();
    const noLimit = await engine.ingest("ep", buy({ orderType: "limit" }));
    expect(noLimit.status).toBe("error");
    expect(noLimit.error).toContain("limitPrice");

    const unknown = await engine.ingest("nope", buy());
    expect(unknown.status).toBe("error");
    expect(unknown.error).toContain("Unknown endpoint");

    const garbage = await engine.ingest("ep", "{{not json her");
    expect(garbage.status).toBe("parse_error");
  });

  it("pause and resume via signals", async () => {
    const { engine } = makeEngine(makeConfig({ dedupeWindowSec: 0 }));
    await engine.ingest("ep", JSON.stringify({ action: "pause" }));
    const blocked = await engine.ingest("ep", buy());
    expect(blocked.status).toBe("rejected");
    expect(blocked.decisions?.find((d) => d.outcome === "reject")?.rule).toBe("paused");

    await engine.ingest("ep", JSON.stringify({ action: "resume" }));
    expect((await engine.ingest("ep", buy({ signalId: "post" }))).status).toBe("executed");
  });

  it("percent-of-equity sizing uses live account equity", async () => {
    const { engine } = makeEngine(makeConfig({ unlimitedPositionSize: true, maxPositionSize: undefined }));
    const record = await engine.ingest("ep", JSON.stringify({ action: "buy", symbol: "AAPL", percentEquity: 10, price: 100 }));
    expect(record.status).toBe("executed");
    expect(record.intent?.notional).toBe(10_000); // 10% of the simulator's 100k
  });
});

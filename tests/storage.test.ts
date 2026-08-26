import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createMemoryStorage } from "../src/storage/memory.js";
import { createSqliteStorage } from "../src/storage/sqlite.js";
import type { StorageDriver } from "../src/storage/driver.js";
import type { SignalRecord } from "../src/types.js";

const record = (id: string, overrides: Partial<SignalRecord> = {}): SignalRecord => ({
  id,
  endpointId: "ep",
  receivedAt: new Date(2026, 0, 1, 12, 0, Number(id.slice(-2)) || 0).toISOString(),
  rawBody: `{"n":${id}}`,
  status: "received",
  ...overrides,
});

const dir = mkdtempSync(join(tmpdir(), "trade-relay-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const drivers: [string, () => StorageDriver][] = [
  ["memory", () => createMemoryStorage()],
  ["sqlite", () => createSqliteStorage(join(dir, `t-${Math.random().toString(36).slice(2)}.db`))],
];

describe.each(drivers)("storage driver: %s", (_name, make) => {
  it("round-trips signal records through insert, update, get, list", () => {
    const storage = make();
    storage.insertSignal(record("01"));
    storage.insertSignal(record("02", { status: "executed", parser: "trade-relay", signal: { action: "buy", symbol: "AAPL" } }));

    const fetched = storage.getSignal("02");
    expect(fetched?.signal).toEqual({ action: "buy", symbol: "AAPL" });

    const updated = { ...record("01"), status: "rejected" as const, decisions: [{ rule: "killSwitch", outcome: "reject" as const }] };
    storage.updateSignal(updated);
    expect(storage.getSignal("01")?.status).toBe("rejected");
    expect(storage.getSignal("01")?.decisions).toHaveLength(1);

    const all = storage.listSignals();
    expect(all).toHaveLength(2);
    expect(all[0]?.id).toBe("02"); // newest first

    expect(storage.listSignals({ status: "executed" })).toHaveLength(1);
    expect(storage.listSignals({ endpointId: "other" })).toHaveLength(0);
    expect(storage.listSignals({ limit: 1 })).toHaveLength(1);
    storage.close();
  });

  it("counts executed signals since a timestamp", () => {
    const storage = make();
    storage.insertSignal(record("01", { status: "executed" }));
    storage.insertSignal(record("02", { status: "executed" }));
    storage.insertSignal(record("03", { status: "rejected" }));
    const since = record("01").receivedAt;
    expect(storage.countSignalsSince("ep", since, ["executed"])).toBe(2);
    expect(storage.countSignalsSince("ep", since, ["rejected"])).toBe(1);
    expect(storage.countSignalsSince("other", since, ["executed"])).toBe(0);
    storage.close();
  });

  it("kv store sets, gets, overwrites, deletes", () => {
    const storage = make();
    expect(storage.kvGet("k")).toBeUndefined();
    storage.kvSet("k", "1");
    expect(storage.kvGet("k")).toBe("1");
    storage.kvSet("k", "2");
    expect(storage.kvGet("k")).toBe("2");
    storage.kvDelete("k");
    expect(storage.kvGet("k")).toBeUndefined();
    storage.close();
  });

  it("stores events newest first", () => {
    const storage = make();
    storage.insertEvent({ id: "e1", at: "2026-01-01T00:00:00Z", type: "startup" });
    storage.insertEvent({ id: "e2", at: "2026-01-02T00:00:00Z", type: "kill_on", detail: "test" });
    const events = storage.listEvents();
    expect(events[0]?.id).toBe("e2");
    expect(events[0]?.detail).toBe("test");
    storage.close();
  });
});

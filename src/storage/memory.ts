import type { RelayEvent, SignalRecord } from "../types.js";
import type { SignalQuery, StorageDriver } from "./driver.js";

/** In-memory driver: tests, and ephemeral runtimes that bring no disk. */
export const createMemoryStorage = (): StorageDriver => {
  const signals = new Map<string, SignalRecord>();
  const kv = new Map<string, string>();
  const events: RelayEvent[] = [];

  const sorted = (): SignalRecord[] =>
    [...signals.values()].sort((a, b) =>
      a.receivedAt === b.receivedAt ? b.id.localeCompare(a.id) : b.receivedAt.localeCompare(a.receivedAt),
    );

  return {
    insertSignal: (record) => {
      signals.set(record.id, structuredClone(record));
    },
    updateSignal: (record) => {
      signals.set(record.id, structuredClone(record));
    },
    getSignal: (id) => {
      const record = signals.get(id);
      return record ? structuredClone(record) : undefined;
    },
    listSignals: (query: SignalQuery = {}) =>
      sorted()
        .filter((record) => (query.status ? record.status === query.status : true))
        .filter((record) => (query.endpointId ? record.endpointId === query.endpointId : true))
        .slice(query.offset ?? 0, (query.offset ?? 0) + (query.limit ?? 100))
        .map((record) => structuredClone(record)),
    countSignalsSince: (endpointId, sinceIso, statuses) =>
      [...signals.values()].filter(
        (record) =>
          record.endpointId === endpointId && record.receivedAt >= sinceIso && statuses.includes(record.status),
      ).length,
    kvGet: (key) => kv.get(key),
    kvSet: (key, value) => {
      kv.set(key, value);
    },
    kvDelete: (key) => {
      kv.delete(key);
    },
    insertEvent: (event) => {
      events.push(structuredClone(event));
    },
    listEvents: (limit = 100) => [...events].reverse().slice(0, limit).map((event) => structuredClone(event)),
    close: () => {},
  };
};

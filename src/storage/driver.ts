import type { RelayEvent, SignalRecord } from "../types.js";

export type SignalQuery = {
  limit?: number;
  offset?: number;
  status?: SignalRecord["status"];
  endpointId?: string;
};

/**
 * The flight recorder's persistence. Synchronous by design: node:sqlite is
 * synchronous, writes are tiny, and a relay that can lose the story of an
 * order to an unflushed buffer is not a flight recorder.
 */
export type StorageDriver = {
  insertSignal: (record: SignalRecord) => void;
  updateSignal: (record: SignalRecord) => void;
  getSignal: (id: string) => SignalRecord | undefined;
  listSignals: (query?: SignalQuery) => SignalRecord[];
  /** Count records for an endpoint at-or-after `sinceIso`, filtered to statuses. */
  countSignalsSince: (endpointId: string, sinceIso: string, statuses: SignalRecord["status"][]) => number;
  kvGet: (key: string) => string | undefined;
  kvSet: (key: string, value: string) => void;
  kvDelete: (key: string) => void;
  insertEvent: (event: RelayEvent) => void;
  listEvents: (limit?: number) => RelayEvent[];
  close: () => void;
};

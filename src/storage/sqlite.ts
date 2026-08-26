import type { RelayEvent, SignalRecord } from "../types.js";
import type { SignalQuery, StorageDriver } from "./driver.js";

// Loaded via process.getBuiltinModule because node:sqlite is still marked
// experimental: bundlers (esbuild included) don't know it as a builtin and
// would rewrite a static import into a bogus "sqlite" package. This API is
// invisible to bundlers and works in Node >= 22.3. Loaded lazily so the
// experimental warning only appears when sqlite storage is actually used.
const loadSqlite = (): typeof import("node:sqlite") =>
  process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");

/*
  SQLite via node:sqlite — zero native dependencies, zero setup. One file
  next to the process holds every signal story. WAL mode so the dashboard
  reads never block the webhook writes.
*/

type SignalRow = {
  id: string;
  endpoint_id: string;
  received_at: string;
  status: string;
  raw_body: string;
  data: string;
};

const toRecord = (row: SignalRow): SignalRecord => ({
  id: row.id,
  endpointId: row.endpoint_id,
  receivedAt: row.received_at,
  status: row.status as SignalRecord["status"],
  rawBody: row.raw_body,
  ...JSON.parse(row.data),
});

const toData = (record: SignalRecord): string => {
  const { id: _id, endpointId: _e, receivedAt: _r, status: _s, rawBody: _b, ...rest } = record;
  return JSON.stringify(rest);
};

export const createSqliteStorage = (path: string): StorageDriver => {
  const { DatabaseSync } = loadSqlite();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (
      id TEXT PRIMARY KEY,
      endpoint_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      status TEXT NOT NULL,
      raw_body TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_signals_received ON signals(received_at DESC);
    CREATE INDEX IF NOT EXISTS idx_signals_endpoint ON signals(endpoint_id, received_at);
    CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      type TEXT NOT NULL,
      detail TEXT
    );
  `);

  const insertSignalStmt = db.prepare(
    "INSERT INTO signals (id, endpoint_id, received_at, status, raw_body, data) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const updateSignalStmt = db.prepare("UPDATE signals SET status = ?, data = ? WHERE id = ?");
  const getSignalStmt = db.prepare("SELECT * FROM signals WHERE id = ?");
  const kvGetStmt = db.prepare("SELECT value FROM kv WHERE key = ?");
  const kvSetStmt = db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  const kvDeleteStmt = db.prepare("DELETE FROM kv WHERE key = ?");
  const insertEventStmt = db.prepare("INSERT INTO events (id, at, type, detail) VALUES (?, ?, ?, ?)");

  return {
    insertSignal: (record) => {
      insertSignalStmt.run(record.id, record.endpointId, record.receivedAt, record.status, record.rawBody, toData(record));
    },
    updateSignal: (record) => {
      updateSignalStmt.run(record.status, toData(record), record.id);
    },
    getSignal: (id) => {
      const row = getSignalStmt.get(id) as SignalRow | undefined;
      return row ? toRecord(row) : undefined;
    },
    listSignals: (query = {}) => {
      const clauses: string[] = [];
      const params: (string | number)[] = [];
      if (query.status) {
        clauses.push("status = ?");
        params.push(query.status);
      }
      if (query.endpointId) {
        clauses.push("endpoint_id = ?");
        params.push(query.endpointId);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db
        .prepare(`SELECT * FROM signals ${where} ORDER BY received_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...params, query.limit ?? 100, query.offset ?? 0) as unknown as SignalRow[];
      return rows.map(toRecord);
    },
    countSignalsSince: (endpointId, sinceIso, statuses) => {
      const placeholders = statuses.map(() => "?").join(", ");
      const row = db
        .prepare(
          `SELECT COUNT(*) AS n FROM signals WHERE endpoint_id = ? AND received_at >= ? AND status IN (${placeholders})`,
        )
        .get(endpointId, sinceIso, ...statuses) as { n: number };
      return row.n;
    },
    kvGet: (key) => (kvGetStmt.get(key) as { value: string } | undefined)?.value,
    kvSet: (key, value) => {
      kvSetStmt.run(key, value);
    },
    kvDelete: (key) => {
      kvDeleteStmt.run(key);
    },
    insertEvent: (event) => {
      insertEventStmt.run(event.id, event.at, event.type, event.detail ?? null);
    },
    listEvents: (limit = 100) => {
      const rows = db.prepare("SELECT * FROM events ORDER BY at DESC, id DESC LIMIT ?").all(limit) as unknown as {
        id: string;
        at: string;
        type: RelayEvent["type"];
        detail: string | null;
      }[];
      return rows.map((row) => ({ id: row.id, at: row.at, type: row.type, ...(row.detail ? { detail: row.detail } : {}) }));
    },
    close: () => {
      db.close();
    },
  };
};

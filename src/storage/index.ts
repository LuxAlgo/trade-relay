import type { RelayConfig } from "../config.js";
import type { StorageDriver } from "./driver.js";
import { createMemoryStorage } from "./memory.js";
import { createSqliteStorage } from "./sqlite.js";

export type { SignalQuery, StorageDriver } from "./driver.js";
export { createMemoryStorage } from "./memory.js";
export { createSqliteStorage } from "./sqlite.js";

export const createStorage = (config: RelayConfig["storage"]): StorageDriver =>
  config.driver === "memory" ? createMemoryStorage() : createSqliteStorage(config.path);

import { connect, type BrokerConnection, type BrokerId } from "@luxalgo/broker-sdk";
import type { RelayConfig } from "../config.js";
import type { BrokerPort } from "./port.js";
import { createSdkPort } from "./sdk-port.js";
import { createSimulator } from "./simulator.js";

export { UnsupportedOrderError } from "./port.js";
export type { BrokerPort, PortCapabilities, PortEquity, PortOrderRequest } from "./port.js";
export { createSimulator } from "./simulator.js";
export type { SimulatorPort } from "./simulator.js";
export { createSdkPort } from "./sdk-port.js";

/**
 * Watch-mode accounts: read-only portfolio views over the broker-sdk read
 * layer (any of its 14 brokers). Shown in the dashboard, never traded.
 */
export const createWatchReaders = (config: RelayConfig): Map<string, BrokerConnection> => {
  const readers = new Map<string, BrokerConnection>();
  for (const account of config.accounts) {
    if (account.mode !== "watch") continue;
    readers.set(
      account.id,
      connect({
        broker: account.broker as BrokerId,
        credentials: account.credentials as never,
        label: account.id,
      }),
    );
  }
  return readers;
};

/** Build a port per execute-mode account. Watch accounts are read elsewhere. */
export const createPorts = (config: RelayConfig): Map<string, BrokerPort> => {
  const ports = new Map<string, BrokerPort>();
  for (const account of config.accounts) {
    if (account.mode === "watch") continue;
    if (account.broker === "simulator") {
      ports.set(
        account.id,
        createSimulator({
          id: account.id,
          startingEquity: account.startingEquity,
          defaultFillPrice: account.defaultFillPrice,
          currency: account.currency,
        }),
      );
    } else if (account.broker === "tradier") {
      ports.set(account.id, createSdkPort({ id: account.id, broker: "tradier", credentials: account.credentials }));
    } else {
      ports.set(
        account.id,
        createSdkPort({
          id: account.id,
          broker: "alpaca",
          credentials: account.credentials,
          ...(account.acknowledgeLiveTrading !== undefined
            ? { acknowledgeLiveTrading: account.acknowledgeLiveTrading }
            : {}),
        }),
      );
    }
  }
  return ports;
};

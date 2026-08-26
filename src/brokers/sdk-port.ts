import { connect, type BrokerSnapshot } from "@luxalgo/broker-sdk";
import { connectTrading, type TradingConnection } from "@luxalgo/broker-sdk/orders";
import type { PortOrder, PortPosition } from "../types.js";
import { UnsupportedOrderError, type BrokerPort, type PortCapabilities, type PortEquity, type PortOrderRequest } from "./port.js";

/*
  The real-broker port. Every call goes through @luxalgo/broker-sdk: the
  write layer for orders, the read layer for positions and equity.

  Coverage tracks the SDK's write rollout: Alpaca paper connects without
  ceremony, Alpaca live only when the operator wrote the SDK's exact
  acknowledgement sentence into their config, and Tradier is pinned to its
  sandbox by the SDK itself. What the SDK cannot express is refused with a
  pointer to the upstream proposal, never emulated against a real account.
*/

const ALPACA_CAPABILITIES: PortCapabilities = {
  orderTypes: ["market", "limit"],
  brackets: false,
  trailing: false,
  notionalMarket: true,
  fractional: true,
};

const TRADIER_CAPABILITIES: PortCapabilities = {
  orderTypes: ["market", "limit"],
  brackets: false,
  trailing: false,
  notionalMarket: false,
  fractional: false,
};

export type SdkPortOptions =
  | {
      id: string;
      broker: "alpaca";
      credentials: { apiKey: string; apiSecret: string };
      /** The SDK's exact live-trading acknowledgement sentence; omit for paper keys. */
      acknowledgeLiveTrading?: string;
      snapshotTtlMs?: number;
    }
  | {
      id: string;
      broker: "tradier";
      credentials: { accessToken: string; accountId?: string | undefined };
    };

export const createSdkPort = (options: SdkPortOptions): BrokerPort => {
  const trading: TradingConnection =
    options.broker === "alpaca"
      ? connectTrading({
          broker: "alpaca",
          credentials: options.credentials,
          ...(options.acknowledgeLiveTrading !== undefined
            ? { acknowledgeLiveTrading: options.acknowledgeLiveTrading }
            : {}),
        })
      : connectTrading({
          broker: "tradier",
          credentials: {
            accessToken: options.credentials.accessToken,
            ...(options.credentials.accountId !== undefined ? { accountId: options.credentials.accountId } : {}),
          },
        });

  const capabilities = options.broker === "alpaca" ? ALPACA_CAPABILITIES : TRADIER_CAPABILITIES;
  const label = `${options.broker} (via broker-sdk)`;

  // Read side. Alpaca reads with the same keys. Tradier's read adapter is
  // production-pinned upstream while its write layer is sandbox-pinned, so
  // sandbox reads are impossible today — rails that need positions or
  // equity fail closed with this message until the upstream ask lands.
  const reader = options.broker === "alpaca" ? connect({ broker: "alpaca", credentials: options.credentials }) : undefined;
  const ttl = options.broker === "alpaca" && options.snapshotTtlMs !== undefined ? options.snapshotTtlMs : 3000;

  let cached: { snapshot: BrokerSnapshot; at: number } | undefined;
  const snapshot = async (): Promise<BrokerSnapshot> => {
    if (!reader) {
      throw new Error(
        "tradier (sandbox): the broker-sdk read adapter is production-pinned, so sandbox positions/equity are unavailable — " +
          "rails and sizing modes that need them fail closed until sandbox reads land upstream (docs/broker-sdk-proposal.md).",
      );
    }
    if (cached && Date.now() - cached.at < ttl) return cached.snapshot;
    const fresh = await reader.fetchSnapshot();
    cached = { snapshot: fresh, at: Date.now() };
    return fresh;
  };

  const account = async () => {
    const { accounts } = await snapshot();
    const match = accounts.find((candidate) => candidate.environment === trading.environment) ?? accounts[0];
    if (!match) throw new Error(`${options.broker}: the snapshot returned no account`);
    return match;
  };

  return {
    id: options.id,
    broker: options.broker,
    environment: trading.environment,
    capabilities: () => ({ ...capabilities, orderTypes: [...capabilities.orderTypes] }),

    placeOrder: async (request): Promise<PortOrder> => {
      if (request.type !== "market" && request.type !== "limit") {
        throw new UnsupportedOrderError(label, `${request.type} orders`);
      }
      if (request.bracket) {
        throw new UnsupportedOrderError(label, "bracket (take-profit/stop-loss) orders");
      }
      if (request.notional !== undefined && !capabilities.notionalMarket) {
        throw new UnsupportedOrderError(label, "notional sizing");
      }
      const order = await trading.placeOrder({
        symbol: request.symbol,
        side: request.side,
        type: request.type,
        ...(request.quantity !== undefined ? { quantity: request.quantity } : {}),
        ...(request.notional !== undefined ? { notional: request.notional } : {}),
        ...(request.limitPrice !== undefined ? { limitPrice: request.limitPrice } : {}),
        timeInForce: request.timeInForce,
        clientOrderId: request.clientOrderId,
      });
      cached = undefined;
      return order;
    },

    getOrder: async (orderId) => trading.getOrder(orderId),

    listOrders: async (listOptions) => trading.listOrders(listOptions),

    cancelOrder: async (orderId) => trading.cancelOrder(orderId),

    cancelAllOrders: async () => {
      const open = await trading.listOrders({ status: "open", limit: 500 });
      await Promise.all(open.map((order) => trading.cancelOrder(order.id)));
      return open.length;
    },

    getPositions: async (): Promise<PortPosition[]> => {
      const current = await account();
      return current.positions.map((position) => ({
        symbol: position.symbol,
        quantity: position.quantity,
        ...(position.marketValue !== undefined ? { marketValue: position.marketValue } : {}),
        ...(position.averageEntryPrice !== undefined ? { averageEntryPrice: position.averageEntryPrice } : {}),
      }));
    },

    getEquity: async (): Promise<PortEquity> => {
      const current = await account();
      return {
        equity: current.equity,
        currency: current.currency,
        ...(current.cash !== undefined ? { cash: current.cash } : {}),
      };
    },
  };
};

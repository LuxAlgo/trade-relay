import type { BracketSpec, OrderKind, PortOrder, PortPosition, TimeInForce } from "../types.js";

/*
  BrokerPort is the one seam between the relay and the outside world. All
  real broker connectivity behind it goes through @luxalgo/broker-sdk —
  trade-relay never speaks a broker's REST dialect itself. What the SDK
  cannot express yet is refused loudly (UnsupportedOrderError), never
  emulated against a real account; the built-in simulator is where the full
  order vocabulary is available today.
*/

export type PortCapabilities = {
  orderTypes: OrderKind[];
  brackets: boolean;
  trailing: boolean;
  /** Market orders sized by currency amount instead of quantity. */
  notionalMarket: boolean;
  fractional: boolean;
};

export type PortOrderRequest = {
  symbol: string;
  side: "buy" | "sell";
  type: OrderKind;
  quantity?: number;
  notional?: number;
  limitPrice?: number;
  stopPrice?: number;
  trailAmount?: number;
  trailPercent?: number;
  timeInForce: TimeInForce;
  clientOrderId: string;
  bracket?: BracketSpec;
  /** Sender-side price; the simulator fills with it, real ports ignore it. */
  referencePrice?: number;
};

export type PortEquity = { equity: number; currency: string; cash?: number };

export type BrokerPort = {
  readonly id: string;
  readonly broker: string;
  readonly environment: "paper" | "sandbox" | "live" | "simulated";
  capabilities: () => PortCapabilities;
  placeOrder: (request: PortOrderRequest) => Promise<PortOrder>;
  getOrder: (orderId: string) => Promise<PortOrder>;
  listOrders: (options?: { status?: "open" | "closed" | "all"; limit?: number }) => Promise<PortOrder[]>;
  cancelOrder: (orderId: string) => Promise<void>;
  /** Cancel every open order; returns how many were canceled. */
  cancelAllOrders: () => Promise<number>;
  getPositions: () => Promise<PortPosition[]>;
  getEquity: () => Promise<PortEquity>;
  /**
   * Price advance hook. The simulator uses it to trigger resting orders
   * (stops, limits, bracket legs) and returns the orders it filled; real
   * ports do not implement it.
   */
  updatePrice?: (symbol: string, price: number) => PortOrder[];
};

/** An order the connected broker layer cannot express yet. */
export class UnsupportedOrderError extends Error {
  constructor(broker: string, feature: string) {
    super(
      `${broker} cannot place ${feature} through @luxalgo/broker-sdk yet. ` +
        `trade-relay will not emulate it against a real account — the capability lands upstream first ` +
        `(see docs/broker-sdk-proposal.md and broker-sdk's docs/orders-rfc.md). ` +
        `The built-in simulator supports it today.`,
    );
    this.name = "UnsupportedOrderError";
  }
}

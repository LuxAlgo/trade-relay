import { randomUUID } from "node:crypto";
import type { BracketSpec, PortBar, PortBarRequest, PortOrder, PortPosition } from "../types.js";
import type { BrokerPort, PortCapabilities, PortEquity, PortOrderRequest } from "./port.js";
import { simulatedBars, type PriceAnchor } from "./simulated-bars.js";

/*
  The built-in simulator: a complete fake broker that fills against the
  prices your signals carry. It exists so every part of the relay — every
  order type, brackets, trailing stops, the risk rails, the flight recorder,
  replay — can be exercised end to end with zero keys and zero risk. It is
  also the reference implementation of the full order vocabulary the SDK
  write layer will grow into.

  Price model: the last price seen per symbol (a signal's reference price,
  or an explicit updatePrice call). No slippage model — honest paper, not
  pretend backtesting. Every price the simulator sees is kept with its
  instant, and getBars draws that history as one-minute bars (see
  simulated-bars.ts): the simulator is the price process, so these are its
  own bars, not market data pretending to be real.
*/

type SimPosition = { quantity: number; avgEntryPrice: number };

type SimOrder = PortOrder & {
  timeInForce: string;
  /** For trailing stops: best price seen since placement. */
  watermark?: number;
  trailAmount?: number;
  trailPercent?: number;
  /** Bracket legs cancel their sibling on fill. */
  ocoSiblingId?: string;
  parentId?: string;
  /** Held until the parent fills, then turned into TP/SL legs. */
  bracketSpec?: BracketSpec | undefined;
};

export type SimulatorOptions = {
  id: string;
  startingEquity: number;
  defaultFillPrice: number;
  currency: string;
  /** Clock, injectable for deterministic tests. */
  now?: () => Date;
};

export type SimulatorPort = BrokerPort & {
  /** Set/advance a symbol's price and trigger resting orders. */
  updatePrice: (symbol: string, price: number) => PortOrder[];
  lastPrice: (symbol: string) => number | undefined;
};

const CAPABILITIES: PortCapabilities = {
  orderTypes: ["market", "limit", "stop", "stop_limit", "trailing_stop"],
  brackets: true,
  trailing: true,
  notionalMarket: true,
  fractional: true,
};

export const createSimulator = (options: SimulatorOptions): SimulatorPort => {
  let cash = options.startingEquity;
  const positions = new Map<string, SimPosition>();
  const orders = new Map<string, SimOrder>();
  const byClientId = new Map<string, string>();
  const prices = new Map<string, number>();
  const anchors = new Map<string, PriceAnchor[]>();
  const now = options.now ?? (() => new Date());

  /** Record that the simulator saw `price` for `symbol` right now. */
  const mark = (symbol: string, price: number): void => {
    prices.set(symbol, price);
    anchors.set(symbol, [...(anchors.get(symbol) ?? []), { time: now().getTime(), price }]);
  };

  const priceFor = (symbol: string, reference?: number): number => {
    if (reference !== undefined) mark(symbol, reference);
    return prices.get(symbol) ?? options.defaultFillPrice;
  };

  const applyFill = (order: SimOrder, fillPrice: number): void => {
    const quantity = order.quantity ?? (order.notional !== undefined ? order.notional / fillPrice : 0);
    const signed = order.side === "buy" ? quantity : -quantity;
    const existing = positions.get(order.symbol) ?? { quantity: 0, avgEntryPrice: 0 };

    const increasing = existing.quantity === 0 || Math.sign(existing.quantity) === Math.sign(signed);
    const next = existing.quantity + signed;
    if (increasing) {
      const totalCost = existing.avgEntryPrice * Math.abs(existing.quantity) + fillPrice * Math.abs(signed);
      existing.avgEntryPrice = totalCost / Math.abs(next);
    } else if (Math.sign(next) !== Math.sign(existing.quantity) && next !== 0) {
      // Crossed through flat: the remainder opens at the fill price.
      existing.avgEntryPrice = fillPrice;
    }
    existing.quantity = next;
    if (existing.quantity === 0) positions.delete(order.symbol);
    else positions.set(order.symbol, existing);

    cash -= signed * fillPrice;
    if (prices.get(order.symbol) !== fillPrice) mark(order.symbol, fillPrice);
    order.status = "filled";
    order.filledQuantity = quantity;
    order.filledAvgPrice = fillPrice;
    if (order.quantity === undefined) order.quantity = quantity;

    if (order.ocoSiblingId) {
      const sibling = orders.get(order.ocoSiblingId);
      if (sibling && (sibling.status === "open" || sibling.status === "pending")) sibling.status = "canceled";
    }
    spawnBracketLegs(order);
  };

  const spawnBracketLegs = (parent: SimOrder): void => {
    if (!parent.bracketSpec) return;
    const spec = parent.bracketSpec;
    parent.bracketSpec = undefined;
    const exitSide = parent.side === "buy" ? "sell" : "buy";
    const quantity = parent.filledQuantity;
    const legs: SimOrder[] = [];
    if (spec.takeProfitPrice !== undefined) {
      legs.push(makeOrder({
        symbol: parent.symbol, side: exitSide, type: "limit", quantity,
        limitPrice: spec.takeProfitPrice, timeInForce: "gtc",
        clientOrderId: `${parent.clientOrderId ?? parent.id}:tp`,
      }, parent.id));
    }
    if (spec.stopLossPrice !== undefined) {
      legs.push(makeOrder({
        symbol: parent.symbol, side: exitSide,
        type: spec.stopLossLimitPrice !== undefined ? "stop_limit" : "stop",
        quantity, stopPrice: spec.stopLossPrice,
        ...(spec.stopLossLimitPrice !== undefined ? { limitPrice: spec.stopLossLimitPrice } : {}),
        timeInForce: "gtc",
        clientOrderId: `${parent.clientOrderId ?? parent.id}:sl`,
      }, parent.id));
    }
    if (legs.length === 2) {
      legs[0]!.ocoSiblingId = legs[1]!.id;
      legs[1]!.ocoSiblingId = legs[0]!.id;
    }
    parent.legs = legs.map(publicOrder);
  };

  type MakeRequest = Omit<PortOrderRequest, "clientOrderId" | "timeInForce"> & { clientOrderId?: string; timeInForce: string };

  const makeOrder = (request: MakeRequest, parentId?: string): SimOrder => {
    const order: SimOrder = {
      id: randomUUID(),
      ...(request.clientOrderId ? { clientOrderId: request.clientOrderId } : {}),
      symbol: request.symbol,
      side: request.side,
      type: request.type,
      status: "open",
      ...(request.quantity !== undefined ? { quantity: request.quantity } : {}),
      ...(request.notional !== undefined ? { notional: request.notional } : {}),
      ...(request.limitPrice !== undefined ? { limitPrice: request.limitPrice } : {}),
      ...(request.stopPrice !== undefined ? { stopPrice: request.stopPrice } : {}),
      filledQuantity: 0,
      submittedAt: now().toISOString(),
      timeInForce: request.timeInForce,
      ...(request.trailAmount !== undefined ? { trailAmount: request.trailAmount } : {}),
      ...(request.trailPercent !== undefined ? { trailPercent: request.trailPercent } : {}),
      ...(parentId ? { parentId } : {}),
    };
    orders.set(order.id, order);
    if (order.clientOrderId) byClientId.set(order.clientOrderId, order.id);
    return order;
  };

  /** Would this resting order execute at `price`? Returns the fill price. */
  const fillPriceAt = (order: SimOrder, price: number): number | undefined => {
    switch (order.type) {
      case "market":
        return price;
      case "limit": {
        const limit = order.limitPrice!;
        if (order.side === "buy" ? price <= limit : price >= limit) return price;
        return undefined;
      }
      case "stop": {
        const stop = order.stopPrice!;
        if (order.side === "buy" ? price >= stop : price <= stop) return price;
        return undefined;
      }
      case "stop_limit": {
        const stop = order.stopPrice!;
        const limit = order.limitPrice!;
        const triggered = order.side === "buy" ? price >= stop : price <= stop;
        if (!triggered) return undefined;
        if (order.side === "buy" ? price <= limit : price >= limit) return price;
        return undefined;
      }
      case "trailing_stop": {
        if (order.watermark === undefined) order.watermark = price;
        order.watermark = order.side === "sell" ? Math.max(order.watermark, price) : Math.min(order.watermark, price);
        const distance = order.trailAmount ?? (order.watermark * (order.trailPercent ?? 0)) / 100;
        const stop = order.side === "sell" ? order.watermark - distance : order.watermark + distance;
        order.stopPrice = Number(stop.toFixed(8));
        if (order.side === "sell" ? price <= stop : price >= stop) return price;
        return undefined;
      }
    }
  };

  const sweep = (symbol: string, price: number): PortOrder[] => {
    const filled: PortOrder[] = [];
    for (const order of orders.values()) {
      if (order.symbol !== symbol || order.status !== "open") continue;
      const fillPrice = fillPriceAt(order, price);
      if (fillPrice !== undefined) {
        applyFill(order, fillPrice);
        filled.push(publicOrder(order));
      }
    }
    return filled;
  };

  const publicOrder = (order: SimOrder): PortOrder => {
    const { timeInForce: _t, watermark: _w, trailAmount: _ta, trailPercent: _tp, ocoSiblingId: _o, parentId: _p, bracketSpec: _b, ...pub } = order;
    return structuredClone(pub);
  };

  return {
    id: options.id,
    broker: "simulator",
    environment: "simulated",
    capabilities: () => ({ ...CAPABILITIES, orderTypes: [...CAPABILITIES.orderTypes] }),

    placeOrder: async (request) => {
      if ((request.type === "limit" || request.type === "stop_limit") && !(request.limitPrice! > 0)) {
        throw new Error(`simulator: ${request.type} orders need a positive limitPrice`);
      }
      if ((request.type === "stop" || request.type === "stop_limit") && !(request.stopPrice! > 0)) {
        throw new Error(`simulator: ${request.type} orders need a positive stopPrice`);
      }
      if (request.type === "trailing_stop" && !(request.trailAmount! > 0) && !(request.trailPercent! > 0)) {
        throw new Error("simulator: trailing_stop orders need trailAmount or trailPercent");
      }
      if ((request.quantity === undefined) === (request.notional === undefined)) {
        throw new Error("simulator: provide exactly one of quantity or notional");
      }
      if (request.notional !== undefined && request.type !== "market") {
        throw new Error("simulator: notional sizing is only supported for market orders");
      }
      const existingId = byClientId.get(request.clientOrderId);
      if (existingId) return publicOrder(orders.get(existingId)!);

      const price = priceFor(request.symbol, request.referencePrice);
      const order = makeOrder(request);
      if (request.bracket) order.bracketSpec = request.bracket;

      const fillPrice = fillPriceAt(order, price);
      if (fillPrice !== undefined) applyFill(order, fillPrice);
      return publicOrder(order);
    },

    getOrder: async (orderId) => {
      const order = orders.get(orderId);
      if (!order) throw new Error(`simulator: no order ${orderId}`);
      return publicOrder(order);
    },

    listOrders: async (listOptions) => {
      const status = listOptions?.status ?? "open";
      const all = [...orders.values()].reverse();
      const matching = all.filter((order) =>
        status === "all" ? true : status === "open" ? order.status === "open" : order.status !== "open",
      );
      return matching.slice(0, listOptions?.limit ?? 100).map(publicOrder);
    },

    cancelOrder: async (orderId) => {
      const order = orders.get(orderId);
      if (!order) throw new Error(`simulator: no order ${orderId}`);
      if (order.status === "open" || order.status === "pending") order.status = "canceled";
    },

    cancelAllOrders: async () => {
      let count = 0;
      for (const order of orders.values()) {
        if (order.status === "open" || order.status === "pending") {
          order.status = "canceled";
          count += 1;
        }
      }
      return count;
    },

    getPositions: async () =>
      [...positions.entries()].map(([symbol, position]): PortPosition => ({
        symbol,
        quantity: position.quantity,
        marketValue: Number((position.quantity * (prices.get(symbol) ?? position.avgEntryPrice)).toFixed(2)),
        averageEntryPrice: Number(position.avgEntryPrice.toFixed(4)),
      })),

    getEquity: async (): Promise<PortEquity> => {
      let value = cash;
      for (const [symbol, position] of positions) {
        value += position.quantity * (prices.get(symbol) ?? position.avgEntryPrice);
      }
      return { equity: Number(value.toFixed(2)), currency: options.currency, cash: Number(cash.toFixed(2)) };
    },

    getTrades: async () =>
      [...orders.values()]
        .filter((order) => order.status === "filled" && order.filledAvgPrice !== undefined && order.filledQuantity > 0)
        .map((order) => ({
          symbol: order.symbol,
          side: order.side,
          quantity: order.filledQuantity,
          price: order.filledAvgPrice!,
          ...(order.submittedAt ? { executedAt: order.submittedAt } : {}),
        })),

    getBars: async (symbol: string, request: PortBarRequest): Promise<PortBar[]> =>
      simulatedBars(symbol, anchors.get(symbol) ?? [], request),

    updatePrice: (symbol, price) => {
      mark(symbol, price);
      return sweep(symbol, price);
    },

    lastPrice: (symbol) => prices.get(symbol),
  };
};

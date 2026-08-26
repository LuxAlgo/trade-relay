import { createHash, randomUUID } from "node:crypto";
import type { EndpointConfig, RelayConfig } from "./config.js";
import type { BrokerPort } from "./brokers/port.js";
import { parsePayload, ParseError } from "./parsers/index.js";
import { evaluateRisk, localClock, type RiskInputs } from "./risk.js";
import { resolveSizing, sizingNeedsEquity, SizingError } from "./sizing.js";
import type { Notifier } from "./notify.js";
import type { StorageDriver } from "./storage/driver.js";
import type { NormalizedSignal, OrderIntent, PortOrder, SignalRecord } from "./types.js";

/*
  The engine: one signal in, one fully-told story out. Every branch — parse
  failure, risk rejection, broker error, fill — ends in the flight recorder
  with reasons attached. The engine never throws for a bad signal; bad
  signals are data, not exceptions.
*/

export type IngestOptions = {
  sourceIp?: string;
  replayOf?: string;
  /** Route a replay somewhere other than the endpoint's default account. */
  accountOverride?: string;
};

export type EngineStatus = {
  killSwitch: { on: boolean; reason?: string };
  pausedEndpoints: string[];
  accounts: { id: string; broker: string; environment: string }[];
};

export type Engine = {
  ingest: (endpointId: string, rawBody: string, options?: IngestOptions) => Promise<SignalRecord>;
  replay: (signalId: string, options?: { accountOverride?: string }) => Promise<SignalRecord>;
  flattenAll: (accountId: string) => Promise<{ canceled: number; orders: PortOrder[] }>;
  setKillSwitch: (on: boolean, reason: string) => void;
  setPaused: (endpointId: string, paused: boolean) => void;
  status: () => EngineStatus;
  ports: Map<string, BrokerPort>;
};

export type EngineDeps = {
  config: RelayConfig;
  storage: StorageDriver;
  ports: Map<string, BrokerPort>;
  notifier: Notifier;
  now?: () => Date;
};

const KILL_KEY = "killSwitch";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** Stable hash of a parsed signal — the duplicate-protection identity. */
const signalHash = (endpointId: string, signal: NormalizedSignal): string => {
  const canonical = JSON.stringify(signal, Object.keys(signal as Record<string, unknown>).sort());
  return sha256(`${endpointId}\n${canonical}`);
};

/** ISO instant of local midnight in a timezone (minute precision). */
const startOfLocalDayIso = (now: Date, timezone: string | undefined): string => {
  if (!timezone) {
    const utcMidnight = new Date(now);
    utcMidnight.setUTCHours(0, 0, 0, 0);
    return utcMidnight.toISOString();
  }
  const { time } = localClock(now, timezone);
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  const sinceMidnightMs = ((hours * 60 + minutes) * 60 + now.getUTCSeconds()) * 1000;
  return new Date(now.getTime() - sinceMidnightMs).toISOString();
};

const terminal = (status: PortOrder["status"]): boolean => status !== "open" && status !== "pending";

export const createEngine = (deps: EngineDeps): Engine => {
  const { config, storage, ports, notifier } = deps;
  const now = deps.now ?? (() => new Date());
  const endpoints = new Map<string, EndpointConfig>(config.endpoints.map((endpoint) => [endpoint.id, endpoint]));

  const killState = (): { on: boolean; reason?: string } => {
    const value = storage.kvGet(KILL_KEY);
    return value ? { on: true, reason: value } : { on: false };
  };

  const setKillSwitch = (on: boolean, reason: string): void => {
    if (on) storage.kvSet(KILL_KEY, reason || "manual");
    else storage.kvDelete(KILL_KEY);
    storage.insertEvent({ id: randomUUID(), at: now().toISOString(), type: on ? "kill_on" : "kill_off", detail: reason });
    notifier.send({
      type: "kill",
      title: on ? "🛑 Kill switch ON" : "✅ Kill switch OFF",
      body: reason || (on ? "All order placement stopped." : "Trading re-enabled."),
    });
  };

  const setPaused = (endpointId: string, paused: boolean): void => {
    if (paused) storage.kvSet(`paused:${endpointId}`, "1");
    else storage.kvDelete(`paused:${endpointId}`);
    storage.insertEvent({
      id: randomUUID(),
      at: now().toISOString(),
      type: paused ? "pause" : "resume",
      detail: endpointId,
    });
  };

  const isPaused = (endpointId: string): boolean => storage.kvGet(`paused:${endpointId}`) === "1";

  const dayPnl = async (accountId: string, port: BrokerPort, timezone: string | undefined): Promise<number | undefined> => {
    const current = now();
    const dayKey = startOfLocalDayIso(current, timezone).slice(0, 10) + (timezone ?? "utc");
    const kvKey = `dayStart:${accountId}:${dayKey}`;
    const { equity } = await port.getEquity();
    const stored = storage.kvGet(kvKey);
    if (stored === undefined) {
      storage.kvSet(kvKey, String(equity));
      return 0;
    }
    return equity - Number(stored);
  };

  const pollFill = async (port: BrokerPort, order: PortOrder): Promise<PortOrder> => {
    if (terminal(order.status) || config.engine.fillPollTimeoutMs === 0) return order;
    const deadline = Date.now() + config.engine.fillPollTimeoutMs;
    let latest = order;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, config.engine.fillPollMs));
      try {
        latest = await port.getOrder(order.id);
      } catch {
        return latest;
      }
      if (terminal(latest.status)) return latest;
    }
    return latest;
  };

  const describeOrder = (order: PortOrder, accountId: string): string => {
    const size = order.quantity !== undefined ? `${order.quantity}` : `$${order.notional}`;
    const fill =
      order.status === "filled" && order.filledAvgPrice !== undefined
        ? ` @ ${order.filledAvgPrice}`
        : ` (${order.status})`;
    return `${order.side.toUpperCase()} ${size} ${order.symbol}${fill} · ${accountId}`;
  };

  const finish = (record: SignalRecord, startedAt: number): SignalRecord => {
    record.latencyMs = Date.now() - startedAt;
    storage.updateSignal(record);
    return record;
  };

  const ingest = async (endpointId: string, rawBody: string, options: IngestOptions = {}): Promise<SignalRecord> => {
    const startedAt = Date.now();
    const record: SignalRecord = {
      id: randomUUID(),
      endpointId,
      receivedAt: now().toISOString(),
      ...(options.sourceIp ? { sourceIp: options.sourceIp } : {}),
      rawBody: rawBody.slice(0, 65_536),
      status: "received",
      ...(options.replayOf ? { replayOf: options.replayOf } : {}),
    };
    storage.insertSignal(record);

    const endpoint = endpoints.get(endpointId);
    if (!endpoint) {
      record.status = "error";
      record.error = `Unknown endpoint "${endpointId}"`;
      return finish(record, startedAt);
    }

    // 1. Parse.
    let signal: NormalizedSignal;
    try {
      const parsed = parsePayload(rawBody, endpoint.parser);
      record.parser = parsed.parser;
      signal = parsed.signal;
      record.signal = signal;
    } catch (error) {
      record.status = "parse_error";
      record.error = error instanceof ParseError ? error.message : `Parser crashed: ${(error as Error).message}`;
      notifier.send({ type: "error", title: "⚠️ Unparseable signal", body: `${endpointId}: ${record.error}` });
      return finish(record, startedAt);
    }

    // 2. Control actions that never reach a broker.
    if (signal.action === "kill") {
      setKillSwitch(true, `kill signal via endpoint "${endpointId}"`);
      record.status = "executed";
      return finish(record, startedAt);
    }
    if (signal.action === "pause" || signal.action === "resume") {
      setPaused(endpointId, signal.action === "pause");
      record.status = "executed";
      return finish(record, startedAt);
    }

    // 3. Resolve the account.
    const accountId = options.accountOverride ?? signal.account ?? endpoint.account;
    record.accountId = accountId;
    const port = ports.get(accountId);
    if (!port) {
      record.status = "error";
      record.error = `Unknown or watch-only account "${accountId}"`;
      return finish(record, startedAt);
    }

    // 4. Duplicate bookkeeping (read previous sighting, then stamp this one).
    const hash = signalHash(endpointId, signal);
    const dedupeKey = `dedupe:${endpointId}:${hash}`;
    const duplicateSeenAt = storage.kvGet(dedupeKey);
    storage.kvSet(dedupeKey, record.receivedAt);

    // 5. A price update from the sender may trigger resting orders (simulator).
    if (signal.symbol && signal.referencePrice !== undefined && port.updatePrice) {
      const triggered = port.updatePrice(signal.symbol, signal.referencePrice);
      if (triggered.length > 0) {
        record.orders = triggered;
        for (const order of triggered) {
          notifier.send({ type: "fill", title: "🎯 Resting order triggered", body: describeOrder(order, accountId) });
        }
      }
    }

    try {
      // 6. Kill/pause/cancel-all/flatten short paths.
      if (signal.action === "cancel_all") {
        if (killState().on) {
          record.status = "rejected";
          record.decisions = [{ rule: "killSwitch", outcome: "reject", reason: "kill switch is ON" }];
          return finish(record, startedAt);
        }
        if (signal.symbol) {
          const open = await port.listOrders({ status: "open", limit: 500 });
          const scoped = open.filter((order) => order.symbol === signal.symbol);
          await Promise.all(scoped.map((order) => port.cancelOrder(order.id)));
          record.status = "executed";
          record.orders = scoped.map((order) => ({ ...order, status: "canceled" as const }));
        } else {
          const count = await port.cancelAllOrders();
          record.status = "executed";
          record.signal = { ...signal, comment: `${count} open order(s) canceled` };
        }
        return finish(record, startedAt);
      }

      if (signal.action === "flatten") {
        if (killState().on) {
          record.status = "rejected";
          record.decisions = [{ rule: "killSwitch", outcome: "reject", reason: "kill switch is ON" }];
          return finish(record, startedAt);
        }
        const result = await flattenAll(accountId);
        record.status = "executed";
        record.orders = result.orders;
        record.signal = { ...signal, comment: `${result.canceled} order(s) canceled, ${result.orders.length} position(s) closed` };
        return finish(record, startedAt);
      }

      // 7. Build the order intent (buy / sell / close).
      const intent = await buildIntent(record, signal, endpoint, port, accountId);
      if (!intent) return finish(record, startedAt); // buildIntent already set status/reason
      record.intent = intent;

      // 8. Risk.
      const timezone = endpoint.risk.tradingHours?.timezone;
      const needsPnl = !endpoint.risk.noDailyLossLimit && endpoint.risk.maxDailyLoss !== undefined && !intent.reduceOnly;
      const positions = await port.getPositions();
      const currentPosition = positions.find((position) => position.symbol === intent.symbol)?.quantity ?? 0;
      const inputs: RiskInputs = {
        intent,
        risk: endpoint.risk,
        now: now(),
        killSwitchOn: killState().on,
        paused: isPaused(endpointId),
        currentPosition,
        ordersToday: storage.countSignalsSince(endpointId, startOfLocalDayIso(now(), timezone), ["executed"]),
        dayPnl: needsPnl ? await dayPnl(accountId, port, timezone) : undefined,
        lastOrderAtForSymbol: storage.kvGet(`lastOrder:${endpointId}:${intent.symbol}`),
        duplicateSeenAt,
      };
      const verdict = evaluateRisk(inputs);
      record.decisions = verdict.decisions;
      if (!verdict.allowed) {
        record.status = "rejected";
        const rejection = verdict.decisions.find((decision) => decision.outcome === "reject");
        notifier.send({
          type: "reject",
          title: "🚫 Signal rejected",
          body: `${endpointId}: ${rejection?.rule} — ${rejection?.reason}`,
        });
        return finish(record, startedAt);
      }

      // 9. Execute and wait briefly for the fill.
      const placed = await port.placeOrder({
        symbol: intent.symbol,
        side: intent.side,
        type: intent.orderType,
        ...(intent.quantity !== undefined ? { quantity: intent.quantity } : {}),
        ...(intent.notional !== undefined ? { notional: intent.notional } : {}),
        ...(intent.limitPrice !== undefined ? { limitPrice: intent.limitPrice } : {}),
        ...(intent.stopPrice !== undefined ? { stopPrice: intent.stopPrice } : {}),
        ...(intent.trailAmount !== undefined ? { trailAmount: intent.trailAmount } : {}),
        ...(intent.trailPercent !== undefined ? { trailPercent: intent.trailPercent } : {}),
        timeInForce: intent.timeInForce,
        clientOrderId: intent.clientOrderId,
        ...(intent.bracket ? { bracket: intent.bracket } : {}),
        ...(intent.referencePrice !== undefined ? { referencePrice: intent.referencePrice } : {}),
      });
      const settled = await pollFill(port, placed);
      record.order = settled;
      record.status = "executed";
      storage.kvSet(`lastOrder:${endpointId}:${intent.symbol}`, record.receivedAt);
      notifier.send({
        type: "fill",
        title: settled.status === "filled" ? "✅ Order filled" : "📨 Order submitted",
        body: describeOrder(settled, accountId),
      });
      return finish(record, startedAt);
    } catch (error) {
      record.status = "error";
      record.error = (error as Error).message;
      notifier.send({ type: "error", title: "❌ Execution error", body: `${endpointId}: ${record.error}` });
      return finish(record, startedAt);
    }
  };

  const buildIntent = async (
    record: SignalRecord,
    signal: NormalizedSignal,
    endpoint: EndpointConfig,
    port: BrokerPort,
    accountId: string,
  ): Promise<OrderIntent | undefined> => {
    const clientOrderId = signal.signalId ?? `tr-${record.id}`;
    const timeInForce = signal.timeInForce ?? endpoint.defaults.timeInForce;

    if (signal.action === "close") {
      const positions = await port.getPositions();
      const position = positions.find((candidate) => candidate.symbol === signal.symbol);
      if (!position || position.quantity === 0) {
        record.status = "noop";
        record.error = `No open position in ${signal.symbol} to close`;
        return undefined;
      }
      // Cancel resting orders on the symbol first — a leftover bracket leg
      // re-opening a position you just closed is a classic account-wrecker.
      const open = await port.listOrders({ status: "open", limit: 500 });
      await Promise.all(
        open.filter((order) => order.symbol === signal.symbol).map((order) => port.cancelOrder(order.id)),
      );
      return {
        accountId,
        symbol: signal.symbol!,
        side: position.quantity > 0 ? "sell" : "buy",
        orderType: "market",
        quantity: Math.abs(position.quantity),
        timeInForce: "day",
        clientOrderId,
        reduceOnly: true,
        ...(signal.referencePrice !== undefined ? { referencePrice: signal.referencePrice } : {}),
      };
    }

    // buy / sell
    const orderType = signal.orderType ?? endpoint.defaults.orderType;
    if ((orderType === "limit" || orderType === "stop_limit") && signal.limitPrice === undefined) {
      record.status = "error";
      record.error = `A ${orderType} order needs a limitPrice`;
      return undefined;
    }
    if ((orderType === "stop" || orderType === "stop_limit") && signal.stopPrice === undefined) {
      record.status = "error";
      record.error = `A ${orderType} order needs a stopPrice`;
      return undefined;
    }
    if (orderType === "trailing_stop" && signal.trailAmount === undefined && signal.trailPercent === undefined) {
      record.status = "error";
      record.error = "A trailing_stop order needs trailAmount or trailPercent";
      return undefined;
    }

    let equity: number | undefined;
    const sizing = signal.sizing ?? endpoint.defaults.sizing;
    if (sizingNeedsEquity(sizing)) {
      equity = (await port.getEquity()).equity;
    }
    let size: { quantity?: number; notional?: number };
    try {
      size = resolveSizing({ signal, defaults: endpoint.defaults, ...(equity !== undefined ? { equity } : {}) });
    } catch (error) {
      record.status = "error";
      record.error = error instanceof SizingError ? error.message : (error as Error).message;
      return undefined;
    }

    return {
      accountId,
      symbol: signal.symbol!,
      side: signal.action === "buy" ? "buy" : "sell",
      orderType,
      ...(size.quantity !== undefined ? { quantity: size.quantity } : {}),
      ...(size.notional !== undefined ? { notional: size.notional } : {}),
      ...(signal.limitPrice !== undefined ? { limitPrice: signal.limitPrice } : {}),
      ...(signal.stopPrice !== undefined ? { stopPrice: signal.stopPrice } : {}),
      ...(signal.trailAmount !== undefined ? { trailAmount: signal.trailAmount } : {}),
      ...(signal.trailPercent !== undefined ? { trailPercent: signal.trailPercent } : {}),
      timeInForce,
      ...(signal.bracket ? { bracket: signal.bracket } : {}),
      ...(signal.referencePrice !== undefined ? { referencePrice: signal.referencePrice } : {}),
      clientOrderId,
    };
  };

  const flattenAll = async (accountId: string): Promise<{ canceled: number; orders: PortOrder[] }> => {
    const port = ports.get(accountId);
    if (!port) throw new Error(`Unknown or watch-only account "${accountId}"`);
    const canceled = await port.cancelAllOrders();
    const positions = await port.getPositions();
    const orders: PortOrder[] = [];
    for (const position of positions) {
      if (position.quantity === 0) continue;
      const placed = await port.placeOrder({
        symbol: position.symbol,
        side: position.quantity > 0 ? "sell" : "buy",
        type: "market",
        quantity: Math.abs(position.quantity),
        timeInForce: "day",
        clientOrderId: `flatten-${randomUUID()}`,
      });
      orders.push(await pollFill(port, placed));
    }
    storage.insertEvent({
      id: randomUUID(),
      at: now().toISOString(),
      type: "flatten",
      detail: `${accountId}: ${canceled} canceled, ${orders.length} closed`,
    });
    notifier.send({
      type: "flatten",
      title: "🧹 Flattened",
      body: `${accountId}: ${canceled} open order(s) canceled, ${orders.length} position(s) closed`,
    });
    return { canceled, orders };
  };

  const replay = async (signalId: string, options: { accountOverride?: string } = {}): Promise<SignalRecord> => {
    const original = storage.getSignal(signalId);
    if (!original) throw new Error(`No signal ${signalId} to replay`);
    const accountId = options.accountOverride ?? original.accountId ?? endpoints.get(original.endpointId)?.account;
    const port = accountId ? ports.get(accountId) : undefined;
    if (port && port.environment === "live") {
      throw new Error("Replay never targets a live account — pick a paper or simulator account");
    }
    return ingest(original.endpointId, original.rawBody, {
      replayOf: signalId,
      ...(options.accountOverride ? { accountOverride: options.accountOverride } : {}),
    });
  };

  return {
    ingest,
    replay,
    flattenAll,
    setKillSwitch,
    setPaused,
    status: () => ({
      killSwitch: killState(),
      pausedEndpoints: config.endpoints.map((endpoint) => endpoint.id).filter(isPaused),
      accounts: [...ports.values()].map((port) => ({ id: port.id, broker: port.broker, environment: port.environment })),
    }),
    ports,
  };
};

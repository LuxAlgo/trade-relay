import { matchRoundTrips } from "@luxalgo/broker-sdk/stats";
import type { BrokerPort } from "./brokers/port.js";
import type { StorageDriver } from "./storage/driver.js";
import type { PortBar, PortOrder, SignalRecord } from "./types.js";

/*
  The tape: every fill the flight recorder holds, per symbol, in a shape a
  chart can draw. Nothing here is a source of truth — it is a read model
  over the recorded signal stories, recomputed on demand. Where the broker
  behind an account can hand us bars they ride along; where it cannot, the
  payload says so (`bars: null, barsSource: "none"`) and the dashboard draws
  the fill path alone. No bar is ever invented.
*/

/** One fill as the flight recorder saw it. */
export type TapeFill = {
  /** The signal story this fill belongs to (opens the row in the dashboard). */
  signalId: string;
  endpointId: string;
  accountId: string;
  orderId: string;
  clientOrderId?: string;
  symbol: string;
  side: "buy" | "sell";
  orderType: PortOrder["type"];
  quantity: number;
  price: number;
  /** When the relay recorded the fill (the flight recorder's clock), ISO 8601. */
  at: string;
  /** True when the order was a resting one (bracket leg, stop) a later price triggered. */
  triggered: boolean;
};

/** An entry matched to an exit, FIFO — the same matching the stats engine uses. */
export type TapePair = {
  accountId: string;
  entrySignalId: string;
  exitSignalId: string;
  entryAt: string;
  exitAt: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
};

export type TapeSymbolSummary = {
  symbol: string;
  fills: number;
  firstAt: string;
  lastAt: string;
  /** Distinct UTC calendar days with at least one fill, ascending. */
  sessions: string[];
  accounts: string[];
};

/** Where the payload's bars came from. Grows one entry per broker that learns to serve bars. */
export type TapeBarsSource = "none" | (string & {});

export type TapeBar = PortBar;

export type TapeResponse = {
  symbol: string;
  from: string | null;
  to: string | null;
  fills: TapeFill[];
  pairs: TapePair[];
  /** Realized P&L over the returned fills, computed by broker-sdk's FIFO matcher. */
  realizedPnl: number;
  bars: TapeBar[] | null;
  barsSource: TapeBarsSource;
  barsTimeframe: string | null;
};

const isFilled = (order: PortOrder): boolean =>
  order.status === "filled" && order.filledQuantity > 0 && order.filledAvgPrice !== undefined && order.filledAvgPrice > 0;

const toFill = (record: SignalRecord, order: PortOrder, triggered: boolean): TapeFill => ({
  signalId: record.id,
  endpointId: record.endpointId,
  accountId: record.accountId ?? "",
  orderId: order.id,
  ...(order.clientOrderId ? { clientOrderId: order.clientOrderId } : {}),
  symbol: order.symbol,
  side: order.side,
  orderType: order.type,
  quantity: order.filledQuantity,
  price: order.filledAvgPrice!,
  at: record.receivedAt,
  triggered,
});

/**
 * Extract every fill from a set of signal stories: the resting orders a
 * signal's price update triggered (`orders`), then the order the signal
 * itself placed — the order the engine executes them in, which matters when
 * both share the story's timestamp. An idempotent re-send returns the same
 * broker order to a second story; the pair account+order id keeps such a
 * fill from being counted twice. Ascending by time, stable within an instant.
 */
export const fillsFromRecords = (records: SignalRecord[]): TapeFill[] => {
  const seen = new Set<string>();
  const fills: TapeFill[] = [];
  const push = (fill: TapeFill): void => {
    const key = `${fill.accountId}\n${fill.orderId}`;
    if (seen.has(key)) return;
    seen.add(key);
    fills.push(fill);
  };
  const chronological = [...records].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  for (const record of chronological) {
    for (const order of record.orders ?? []) {
      if (isFilled(order)) push(toFill(record, order, true));
    }
    if (record.order && isFilled(record.order)) push(toFill(record, record.order, false));
  }
  return fills.sort((a, b) => a.at.localeCompare(b.at));
};

/**
 * Walk the whole flight recorder page by page. Stories are small and local;
 * the tape is a dashboard read, not a hot path.
 */
export const collectFills = (storage: StorageDriver, pageSize = 500): TapeFill[] => {
  const records: SignalRecord[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = storage.listSignals({ status: "executed", limit: pageSize, offset });
    records.push(...page);
    if (page.length < pageSize) break;
  }
  return fillsFromRecords(records);
};

/**
 * FIFO entry→exit pairs, per account: buys open lots, sells close them
 * oldest-first, a sell with no open lot stays unpaired (history that starts
 * mid-position is not guessed at). These are the exact rules of broker-sdk's
 * `matchRoundTrips`, which only reports each round trip's P&L; the chart needs
 * both ends of the line, so the walk is repeated here and its totals are held
 * to the SDK's in tests. Partial fills split across lots produce one pair per lot.
 */
export const pairFills = (fills: TapeFill[]): TapePair[] => {
  const sorted = [...fills].sort((a, b) => a.at.localeCompare(b.at));
  const lots = new Map<string, { fill: TapeFill; remaining: number }[]>();
  const pairs: TapePair[] = [];
  for (const fill of sorted) {
    const key = `${fill.accountId}\n${fill.symbol}`;
    const open = lots.get(key) ?? [];
    if (fill.side === "buy") {
      open.push({ fill, remaining: fill.quantity });
      lots.set(key, open);
      continue;
    }
    let remaining = fill.quantity;
    while (remaining > 1e-9 && open.length > 0) {
      const lot = open[0]!;
      const matched = Math.min(remaining, lot.remaining);
      pairs.push({
        accountId: fill.accountId,
        entrySignalId: lot.fill.signalId,
        exitSignalId: fill.signalId,
        entryAt: lot.fill.at,
        exitAt: fill.at,
        entryPrice: lot.fill.price,
        exitPrice: fill.price,
        quantity: matched,
        pnl: (fill.price - lot.fill.price) * matched,
      });
      lot.remaining -= matched;
      remaining -= matched;
      if (lot.remaining <= 1e-9) open.shift();
    }
  }
  return pairs;
};

/** Realized P&L over a fill set, straight from broker-sdk's stats engine. */
export const realizedPnl = (fills: TapeFill[]): number => {
  let total = 0;
  const byAccount = new Map<string, TapeFill[]>();
  for (const fill of fills) byAccount.set(fill.accountId, [...(byAccount.get(fill.accountId) ?? []), fill]);
  for (const accountFills of byAccount.values()) {
    const trips = matchRoundTrips(
      accountFills.map((fill) => ({
        symbol: fill.symbol,
        side: fill.side,
        quantity: fill.quantity,
        price: fill.price,
        executedAt: fill.at,
      })),
    );
    total += trips.reduce((sum, trip) => sum + trip.pnl, 0);
  }
  return total;
};

export const summarizeSymbols = (fills: TapeFill[]): TapeSymbolSummary[] => {
  const bySymbol = new Map<string, TapeFill[]>();
  for (const fill of fills) bySymbol.set(fill.symbol, [...(bySymbol.get(fill.symbol) ?? []), fill]);
  return [...bySymbol.entries()]
    .map(([symbol, symbolFills]) => {
      const sorted = [...symbolFills].sort((a, b) => a.at.localeCompare(b.at));
      return {
        symbol,
        fills: sorted.length,
        firstAt: sorted[0]!.at,
        lastAt: sorted[sorted.length - 1]!.at,
        sessions: [...new Set(sorted.map((fill) => fill.at.slice(0, 10)))].sort(),
        accounts: [...new Set(sorted.map((fill) => fill.accountId))].sort(),
      };
    })
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
};

export type TapeRange = { from?: string | undefined; to?: string | undefined };

const inRange = (fill: TapeFill, range: TapeRange): boolean =>
  (range.from === undefined || fill.at >= range.from) && (range.to === undefined || fill.at <= range.to);

const NO_BARS = { bars: null, source: "none", timeframe: null } as const;

/**
 * Bars for a symbol from the account's broker port, labelled by who drew
 * them: "simulator" for the simulator's own price history, the broker id
 * when @luxalgo/broker-sdk supplied them, "none" when the port has no bar
 * capability (or it failed) — then the dashboard charts the fill path alone.
 * The relay never fills the gap with bars of its own.
 */
export const barsForPort = async (
  port: BrokerPort | undefined,
  symbol: string,
  range: TapeRange,
): Promise<{ bars: TapeBar[] | null; source: TapeBarsSource; timeframe: string | null }> => {
  if (!port?.getBars) return NO_BARS;
  try {
    const from = range.from !== undefined ? Date.parse(range.from) : undefined;
    const to = range.to !== undefined ? Date.parse(range.to) : undefined;
    const bars = await port.getBars(symbol, {
      timeframe: "1m",
      ...(from !== undefined && !Number.isNaN(from) ? { from } : {}),
      ...(to !== undefined && !Number.isNaN(to) ? { to } : {}),
    });
    if (bars.length === 0) return NO_BARS;
    return { bars, source: port.broker, timeframe: "1m" };
  } catch {
    // A failing bar feed must not take the fills with it.
    return NO_BARS;
  }
};

/**
 * The tape for one symbol: the fills inside the range, their FIFO pairs,
 * realized P&L, and whatever bars the account's port could supply. Pairs
 * are matched over the whole history first and then filtered, so a range
 * that starts mid-position still sees its exits paired with their entries.
 */
export const buildTape = async (
  symbol: string,
  allFills: TapeFill[],
  range: TapeRange,
  ports: Map<string, BrokerPort>,
  accountId?: string,
): Promise<TapeResponse> => {
  const symbolFills = allFills.filter(
    (fill) => fill.symbol === symbol && (accountId === undefined || fill.accountId === accountId),
  );
  const fills = symbolFills.filter((fill) => inRange(fill, range));
  const inWindow = new Set(fills.map((fill) => fill.signalId));
  const pairs = pairFills(symbolFills).filter((pair) => inWindow.has(pair.entrySignalId) || inWindow.has(pair.exitSignalId));
  const port = ports.get(accountId ?? fills[0]?.accountId ?? "");
  const bars = await barsForPort(port, symbol, range);
  return {
    symbol,
    from: range.from ?? null,
    to: range.to ?? null,
    fills,
    pairs,
    realizedPnl: Number(realizedPnl(fills).toFixed(4)),
    bars: bars.bars,
    barsSource: bars.source,
    barsTimeframe: bars.timeframe,
  };
};

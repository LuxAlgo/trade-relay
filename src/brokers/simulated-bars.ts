import type { PortBar, PortBarRequest } from "../types.js";

/*
  The simulator's price bars. The simulator IS the price process behind
  every simulated fill — a symbol's price is whatever the signals said it
  was, when they said it — so these bars are legitimate simulator data,
  not fabricated market data: they are the simulator's own price history
  drawn at one-minute resolution. Each anchor (a price the simulator saw at
  an instant) is hit exactly by the bar that contains it; between anchors
  the path is a seeded random bridge, so the same history always draws the
  same bars and nothing wanders away from what the simulator actually did.
*/

export type PriceAnchor = { time: number; price: number };

const MINUTE_MS = 60_000;
/** Bars drawn past the last anchor so the final fill is not glued to the right edge. */
const TAIL_BARS = 3;

/** FNV-1a over a string, for a seed that follows the history it draws. */
const hashSeed = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

/** mulberry32: small, fast, deterministic. Returns numbers in [0, 1). */
const rng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const bucketOf = (time: number): number => Math.floor(time / MINUTE_MS) * MINUTE_MS;
const round = (value: number): number => Number(value.toFixed(6));

/**
 * One-minute bars over a symbol's anchors: the first bar opens at the
 * first anchor's price, every anchor lies inside its bar's range with the
 * bar closing on the last anchor of that minute, minutes without an anchor
 * follow a seeded bridge between the surrounding anchors, and a few bars
 * continue past the last one. `from`/`to` only trim the result — the walk
 * itself is a function of the anchors alone, so any window shows the same bars.
 */
export const simulatedBars = (symbol: string, anchors: PriceAnchor[], request: PortBarRequest): PortBar[] => {
  if (anchors.length === 0) return [];
  const sorted = [...anchors].sort((a, b) => a.time - b.time);
  const next = rng(hashSeed(`${symbol}|${sorted.map((anchor) => `${anchor.time}:${anchor.price}`).join("|")}`));
  const firstBucket = bucketOf(sorted[0]!.time);
  const lastBucket = bucketOf(sorted[sorted.length - 1]!.time);

  const byBucket = new Map<number, PriceAnchor[]>();
  for (const anchor of sorted) {
    const bucket = bucketOf(anchor.time);
    byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), anchor]);
  }
  const anchoredBuckets = [...byBucket.keys()].sort((a, b) => a - b);

  const bars: PortBar[] = [];
  let previousClose = sorted[0]!.price;
  for (let time = firstBucket; time <= lastBucket + TAIL_BARS * MINUTE_MS; time += MINUTE_MS) {
    const here = byBucket.get(time);
    let close: number;
    if (here) {
      close = here[here.length - 1]!.price;
    } else if (time > lastBucket) {
      // Past the last anchor: a quiet drift-free tail.
      close = previousClose * (1 + (next() - 0.5) * 0.0008);
    } else {
      // Between two anchored minutes: linear path plus a bridge that is
      // zero at both ends, so the anchors stay exact.
      const beforeBucket = anchoredBuckets.filter((bucket) => bucket < time).pop()!;
      const afterBucket = anchoredBuckets.find((bucket) => bucket > time)!;
      const before = byBucket.get(beforeBucket)!;
      const after = byBucket.get(afterBucket)!;
      const priceBefore = before[before.length - 1]!.price;
      const priceAfter = after[0]!.price;
      const fraction = (time - beforeBucket) / (afterBucket - beforeBucket);
      const linear = priceBefore + (priceAfter - priceBefore) * fraction;
      const amplitude = Math.max(Math.abs(priceAfter - priceBefore), priceBefore * 0.002) * 0.4;
      close = linear + (next() - 0.5) * 2 * amplitude * Math.sqrt(fraction * (1 - fraction));
    }
    const open = previousClose;
    const touched = [open, close, ...(here ?? []).map((anchor) => anchor.price)];
    const wick = Math.max(open, close) * 0.0003;
    const high = Math.max(...touched) + next() * wick;
    const low = Math.min(...touched) - next() * wick;
    bars.push({ time, open: round(open), high: round(high), low: round(low), close: round(close) });
    previousClose = close;
  }

  return bars.filter(
    (bar) => (request.from === undefined || bar.time >= request.from) && (request.to === undefined || bar.time <= request.to),
  );
};

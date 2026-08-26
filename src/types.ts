/** What a signal asks the relay to do. */
export type SignalAction =
  | "buy"
  | "sell"
  | "close"
  | "flatten"
  | "cancel_all"
  | "pause"
  | "resume"
  | "kill";

export type OrderKind = "market" | "limit" | "stop" | "stop_limit" | "trailing_stop";

export type TimeInForce = "day" | "gtc" | "ioc" | "fok";

export type Sizing =
  | { mode: "quantity"; value: number }
  | { mode: "notional"; value: number }
  | { mode: "percent_equity"; value: number }
  | { mode: "risk_percent"; value: number };

/** Exit orders attached to an entry: take-profit and/or stop-loss. */
export type BracketSpec = {
  takeProfitPrice?: number;
  stopLossPrice?: number;
  /** Makes the stop-loss a stop-limit instead of a stop-market. */
  stopLossLimitPrice?: number;
};

/**
 * The one shape every parser produces, whatever the sender's format.
 * Everything downstream (risk, sizing, execution) works from this.
 */
export type NormalizedSignal = {
  action: SignalAction;
  /** Required for buy/sell/close. Optional for cancel_all (scopes it). */
  symbol?: string;
  sizing?: Sizing;
  orderType?: OrderKind;
  limitPrice?: number;
  stopPrice?: number;
  trailAmount?: number;
  trailPercent?: number;
  timeInForce?: TimeInForce;
  bracket?: BracketSpec;
  /**
   * Price at the sender's side (e.g. TradingView's {{close}}). Used for
   * sizing math and simulator fills — never sent to a broker as a price.
   */
  referencePrice?: number;
  /** Which configured account to route to; endpoint default otherwise. */
  account?: string;
  /** Sender-supplied unique id — becomes the broker idempotency key. */
  signalId?: string;
  comment?: string;
};

/** One risk rule's verdict on a proposed order. */
export type RuleDecision = {
  rule: string;
  outcome: "pass" | "reject" | "skip";
  reason?: string;
};

export type RiskVerdict = {
  allowed: boolean;
  decisions: RuleDecision[];
};

/** A fully-resolved order the engine wants to place, post-risk, post-sizing. */
export type OrderIntent = {
  accountId: string;
  symbol: string;
  side: "buy" | "sell";
  orderType: OrderKind;
  quantity?: number;
  notional?: number;
  limitPrice?: number;
  stopPrice?: number;
  trailAmount?: number;
  trailPercent?: number;
  timeInForce: TimeInForce;
  bracket?: BracketSpec;
  referencePrice?: number;
  clientOrderId: string;
  /** True when the intent came from a close/flatten — it only ever reduces exposure. */
  reduceOnly?: boolean;
};

export type PortOrderStatus =
  | "open"
  | "partially_filled"
  | "filled"
  | "canceled"
  | "expired"
  | "rejected"
  | "pending";

/** Normalized order as reported back by a broker port. */
export type PortOrder = {
  id: string;
  clientOrderId?: string;
  symbol: string;
  side: "buy" | "sell";
  type: OrderKind;
  status: PortOrderStatus;
  quantity?: number;
  notional?: number;
  limitPrice?: number;
  stopPrice?: number;
  filledQuantity: number;
  filledAvgPrice?: number;
  submittedAt?: string;
  /** Child orders (bracket legs) when the port supports them. */
  legs?: PortOrder[];
};

export type PortPosition = {
  symbol: string;
  quantity: number;
  marketValue?: number;
  averageEntryPrice?: number;
};

/** The complete story of one signal, as the flight recorder keeps it. */
export type SignalRecord = {
  id: string;
  endpointId: string;
  receivedAt: string;
  sourceIp?: string;
  rawBody: string;
  parser?: string;
  signal?: NormalizedSignal;
  intent?: OrderIntent;
  decisions?: RuleDecision[];
  status: "received" | "parse_error" | "rejected" | "executed" | "noop" | "error";
  error?: string;
  order?: PortOrder;
  /** Multiple orders from one signal: flatten, or resting orders a price update triggered. */
  orders?: PortOrder[];
  accountId?: string;
  latencyMs?: number;
  /** Set when this record was produced by replaying another one. */
  replayOf?: string;
};

export type RelayEvent = {
  id: string;
  at: string;
  type: "kill_on" | "kill_off" | "pause" | "resume" | "flatten" | "config_loaded" | "startup";
  detail?: string;
};

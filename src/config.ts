import { readFileSync } from "node:fs";
import { z } from "zod";

/*
  Configuration. Two commitments live here:

  1. Secrets stay in the environment. Config files carry ${VAR} references,
     interpolated at load — so the file is safe to commit and the keys never
     are.
  2. The rails are on by default. A route must either configure each rail or
     consciously loosen it with an explicit flag whose name says what it does
     (allowAnySymbol, unlimitedPositionSize, noDailyLossLimit). Silence is
     not consent; a missing rail with no flag fails validation.
*/

const sizingSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("quantity"), value: z.number().positive() }),
  z.object({ mode: z.literal("notional"), value: z.number().positive() }),
  z.object({ mode: z.literal("percent_equity"), value: z.number().positive().max(100) }),
  z.object({ mode: z.literal("risk_percent"), value: z.number().positive().max(100) }),
]);

const DAY_NAMES = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const tradingHoursSchema = z.object({
  timezone: z.string().min(1),
  windows: z
    .array(
      z.object({
        days: z.array(z.enum(DAY_NAMES)).min(1),
        start: z.string().regex(TIME_RE, "expected HH:MM"),
        end: z.string().regex(TIME_RE, "expected HH:MM"),
      }),
    )
    .min(1),
});

const riskSchema = z.object({
  symbolAllowlist: z.array(z.string().min(1)).optional(),
  /** Conscious loosening: trade any symbol the sender names. */
  allowAnySymbol: z.boolean().default(false),
  maxPositionSize: z
    .object({
      quantity: z.number().positive().optional(),
      notional: z.number().positive().optional(),
    })
    .refine((v) => v.quantity !== undefined || v.notional !== undefined, {
      message: "maxPositionSize needs quantity and/or notional",
    })
    .optional(),
  /** Conscious loosening: no cap on position size. */
  unlimitedPositionSize: z.boolean().default(false),
  /** In account currency. Once breached, only risk-reducing orders pass. */
  maxDailyLoss: z.number().positive().optional(),
  /** Conscious loosening: no daily loss cutoff. */
  noDailyLossLimit: z.boolean().default(false),
  maxOrdersPerDay: z.number().int().positive().default(100),
  /** Identical signals inside this window are dropped. 0 disables. */
  dedupeWindowSec: z.number().min(0).default(10),
  /** Minimum seconds between orders on the same symbol. 0 disables. */
  cooldownSec: z.number().min(0).default(0),
  tradingHours: tradingHoursSchema.optional(),
});

const endpointDefaultsSchema = z.object({
  sizing: sizingSchema.default({ mode: "quantity", value: 1 }),
  orderType: z.enum(["market", "limit", "stop", "stop_limit", "trailing_stop"]).default("market"),
  timeInForce: z.enum(["day", "gtc", "ioc", "fok"]).default("day"),
  /** Allow fractional quantities when sizing math produces them. */
  fractional: z.boolean().default(false),
});

const endpointSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-_]*$/i, "endpoint ids are alphanumeric with - or _"),
  /** The secret path segment: POST /webhook/<token>. Long and random. */
  token: z.string().min(16, "webhook tokens must be at least 16 characters — try: openssl rand -hex 24"),
  /** Optional HMAC-SHA256 of the raw body, checked from the X-Signature header. */
  hmacSecret: z.string().min(16).optional(),
  parser: z.enum(["auto", "trade-relay", "traderspost", "text"]).default("auto"),
  /** The execute-mode account this endpoint routes to by default. */
  account: z.string().min(1),
  defaults: endpointDefaultsSchema.default({}),
  risk: riskSchema.default({}),
});

const executeAccountSchema = z.discriminatedUnion("broker", [
  z.object({
    id: z.string().min(1),
    mode: z.literal("execute").default("execute"),
    broker: z.literal("alpaca"),
    credentials: z.object({ apiKey: z.string().min(1), apiSecret: z.string().min(1) }),
    /**
     * Required only for LIVE keys: broker-sdk's exact acknowledgement
     * sentence, verbatim. Write it into the config yourself — it is the
     * point that no tool writes it for you.
     */
    acknowledgeLiveTrading: z.string().optional(),
  }),
  z.object({
    id: z.string().min(1),
    mode: z.literal("execute").default("execute"),
    broker: z.literal("tradier"),
    /** Sandbox only — broker-sdk pins Tradier trading to the sandbox host. */
    credentials: z.object({ accessToken: z.string().min(1), accountId: z.string().optional() }),
  }),
  z.object({
    id: z.string().min(1),
    mode: z.literal("execute").default("execute"),
    broker: z.literal("simulator"),
    startingEquity: z.number().positive().default(100_000),
    /** Fill price used when a signal carries no reference price. */
    defaultFillPrice: z.number().positive().default(100),
    currency: z.string().default("USD"),
  }),
]);

/** Read-only portfolio view via the broker-sdk read layer — never traded. */
const watchAccountSchema = z.object({
  id: z.string().min(1),
  mode: z.literal("watch"),
  broker: z.string().min(1),
  credentials: z.record(z.string(), z.string()),
});

const accountSchema = z.union([executeAccountSchema, watchAccountSchema]);

const notificationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["discord", "slack", "webhook"]),
    url: z.string().url(),
    events: z.array(z.enum(["fill", "reject", "error", "kill", "flatten"])).default(["fill", "reject", "error", "kill", "flatten"]),
  }),
  z.object({
    type: z.literal("telegram"),
    botToken: z.string().min(1),
    chatId: z.string().min(1),
    events: z.array(z.enum(["fill", "reject", "error", "kill", "flatten"])).default(["fill", "reject", "error", "kill", "flatten"]),
  }),
]);

export const configSchema = z
  .object({
    server: z
      .object({
        host: z.string().default("0.0.0.0"),
        port: z.number().int().min(1).max(65535).default(8484),
        /** Bearer token for the dashboard and REST API. */
        dashboardToken: z.string().min(16).optional(),
        /** Trust X-Forwarded-For from a reverse proxy for source IPs. */
        trustProxyHeader: z.boolean().default(false),
      })
      .default({}),
    storage: z
      .object({
        driver: z.enum(["sqlite", "memory"]).default("sqlite"),
        path: z.string().default("./trade-relay.db"),
      })
      .default({}),
    accounts: z.array(accountSchema).min(1),
    endpoints: z.array(endpointSchema).min(1),
    notifications: z.array(notificationSchema).default([]),
    mcp: z
      .object({
        /** Off by default: agents read; only a human-set flag lets them trade. */
        allowTrading: z.boolean().default(false),
      })
      .default({}),
    engine: z
      .object({
        fillPollMs: z.number().int().min(50).default(300),
        fillPollTimeoutMs: z.number().int().min(0).default(3000),
      })
      .default({}),
  })
  .superRefine((config, ctx) => {
    const accountIds = new Set(config.accounts.map((account) => account.id));
    if (accountIds.size !== config.accounts.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["accounts"], message: "account ids must be unique" });
    }
    const executeIds = new Set(
      config.accounts.filter((account) => account.mode !== "watch").map((account) => account.id),
    );
    const endpointIds = new Set<string>();
    const tokens = new Set<string>();
    config.endpoints.forEach((endpoint, index) => {
      if (endpointIds.has(endpoint.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endpoints", index, "id"], message: `duplicate endpoint id "${endpoint.id}"` });
      }
      endpointIds.add(endpoint.id);
      if (tokens.has(endpoint.token)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["endpoints", index, "token"], message: "endpoint tokens must be unique" });
      }
      tokens.add(endpoint.token);
      if (!executeIds.has(endpoint.account)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endpoints", index, "account"],
          message: `endpoint "${endpoint.id}" routes to unknown execute account "${endpoint.account}"`,
        });
      }
      const risk = endpoint.risk;
      if (!risk.allowAnySymbol && (!risk.symbolAllowlist || risk.symbolAllowlist.length === 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endpoints", index, "risk"],
          message: `endpoint "${endpoint.id}": set risk.symbolAllowlist, or consciously loosen with risk.allowAnySymbol: true`,
        });
      }
      if (!risk.unlimitedPositionSize && !risk.maxPositionSize) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endpoints", index, "risk"],
          message: `endpoint "${endpoint.id}": set risk.maxPositionSize, or consciously loosen with risk.unlimitedPositionSize: true`,
        });
      }
      if (!risk.noDailyLossLimit && risk.maxDailyLoss === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["endpoints", index, "risk"],
          message: `endpoint "${endpoint.id}": set risk.maxDailyLoss, or consciously loosen with risk.noDailyLossLimit: true`,
        });
      }
    });
  });

export type RelayConfig = z.infer<typeof configSchema>;
export type EndpointConfig = RelayConfig["endpoints"][number];
export type RiskConfig = EndpointConfig["risk"];
export type EndpointDefaults = EndpointConfig["defaults"];
export type AccountConfig = RelayConfig["accounts"][number];
export type ExecuteAccountConfig = Extract<AccountConfig, { mode?: "execute" }>;
export type NotificationConfig = RelayConfig["notifications"][number];

/** Replace every ${VAR} in string values with process.env.VAR; fail on unset vars. */
export const interpolateEnv = (value: unknown, env: Record<string, string | undefined> = process.env): unknown => {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => {
      const resolved = env[name];
      if (resolved === undefined) {
        throw new Error(`Config references \${${name}} but the environment variable is not set`);
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) return value.map((item) => interpolateEnv(item, env));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateEnv(item, env)]));
  }
  return value;
};

export const parseConfig = (raw: unknown, env?: Record<string, string | undefined>): RelayConfig => {
  const interpolated = interpolateEnv(raw, env);
  const result = configSchema.safeParse(interpolated);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid trade-relay config:\n${details}`);
  }
  return result.data;
};

export const loadConfig = (path: string, env?: Record<string, string | undefined>): RelayConfig => {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`Cannot read config file at ${path} — run \`trade-relay init\` to create one`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Config file ${path} is not valid JSON: ${(error as Error).message}`);
  }
  return parseConfig(raw, env);
};

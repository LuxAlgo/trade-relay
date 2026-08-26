import { describe, expect, it } from "vitest";
import { interpolateEnv, parseConfig } from "../src/config.js";

const valid = () => ({
  accounts: [{ id: "sim", broker: "simulator" }],
  endpoints: [
    {
      id: "tv",
      token: "0123456789abcdef",
      account: "sim",
      risk: { symbolAllowlist: ["AAPL"], maxPositionSize: { quantity: 10 }, maxDailyLoss: 100 },
    },
  ],
});

describe("config", () => {
  it("parses a minimal config and applies defaults", () => {
    const config = parseConfig(valid());
    expect(config.server.port).toBe(8484);
    expect(config.storage.driver).toBe("sqlite");
    expect(config.mcp.allowTrading).toBe(false);
    expect(config.endpoints[0]?.parser).toBe("auto");
    expect(config.endpoints[0]?.defaults.sizing).toEqual({ mode: "quantity", value: 1 });
    expect(config.endpoints[0]?.risk.dedupeWindowSec).toBe(10);
    expect(config.endpoints[0]?.risk.maxOrdersPerDay).toBe(100);
  });

  it("rails must be configured or consciously loosened", () => {
    const missingAllowlist = valid();
    missingAllowlist.endpoints[0]!.risk = { maxPositionSize: { quantity: 10 }, maxDailyLoss: 100 } as never;
    expect(() => parseConfig(missingAllowlist)).toThrow(/allowAnySymbol/);

    const missingCap = valid();
    missingCap.endpoints[0]!.risk = { symbolAllowlist: ["AAPL"], maxDailyLoss: 100 } as never;
    expect(() => parseConfig(missingCap)).toThrow(/unlimitedPositionSize/);

    const missingLoss = valid();
    missingLoss.endpoints[0]!.risk = { symbolAllowlist: ["AAPL"], maxPositionSize: { quantity: 10 } } as never;
    expect(() => parseConfig(missingLoss)).toThrow(/noDailyLossLimit/);

    const loosened = valid();
    loosened.endpoints[0]!.risk = { allowAnySymbol: true, unlimitedPositionSize: true, noDailyLossLimit: true } as never;
    expect(() => parseConfig(loosened)).not.toThrow();
  });

  it("rejects weak webhook tokens", () => {
    const weak = valid();
    weak.endpoints[0]!.token = "short";
    expect(() => parseConfig(weak)).toThrow(/16 characters/);
  });

  it("rejects endpoints routed to unknown or watch-only accounts", () => {
    const unknown = valid();
    unknown.endpoints[0]!.account = "nope";
    expect(() => parseConfig(unknown)).toThrow(/unknown execute account/);

    const watch = {
      accounts: [
        { id: "sim", broker: "simulator" },
        { id: "eyes", mode: "watch", broker: "kraken", credentials: { apiKey: "k", apiSecret: "s" } },
      ],
      endpoints: [{ ...valid().endpoints[0]!, account: "eyes" }],
    };
    expect(() => parseConfig(watch)).toThrow(/unknown execute account/);
  });

  it("rejects duplicate endpoint tokens and account ids", () => {
    const dup = valid();
    dup.endpoints.push({ ...dup.endpoints[0]!, id: "tv2" });
    expect(() => parseConfig(dup)).toThrow(/unique/);
  });

  it("interpolates ${VARS} and fails on unset ones", () => {
    const env = { TOKEN: "0123456789abcdef" };
    expect(interpolateEnv({ a: "x-${TOKEN}-y" }, env)).toEqual({ a: "x-0123456789abcdef-y" });
    expect(() => interpolateEnv("${MISSING_VAR}", env)).toThrow(/MISSING_VAR/);
  });

  it("accepts alpaca, tradier, and watch accounts", () => {
    const config = parseConfig({
      accounts: [
        { id: "paper", broker: "alpaca", credentials: { apiKey: "PKTEST", apiSecret: "secret" } },
        {
          id: "real",
          broker: "alpaca",
          credentials: { apiKey: "AKLIVE", apiSecret: "secret" },
          acknowledgeLiveTrading: "I understand this places real orders with real money",
        },
        { id: "sand", broker: "tradier", credentials: { accessToken: "sandbox-token" } },
        { id: "sim", broker: "simulator" },
        { id: "eyes", mode: "watch", broker: "kraken", credentials: { apiKey: "k", apiSecret: "s" } },
      ],
      endpoints: valid().endpoints,
      notifications: [{ type: "discord", url: "https://discord.com/api/webhooks/x" }],
    });
    expect(config.accounts).toHaveLength(5);
    const live = config.accounts.find((account) => account.id === "real");
    expect(live && "acknowledgeLiveTrading" in live && live.acknowledgeLiveTrading).toContain("real money");
    expect(config.notifications[0]?.events).toContain("fill");
  });
});

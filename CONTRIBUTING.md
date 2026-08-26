# Contributing

```bash
pnpm install
pnpm check        # typecheck + tests — must be green
pnpm build
```

Node ≥ 22.13 (we use `node:sqlite`). No other services needed: the whole pipeline, simulator included, runs in-process.

## Where things go

- **Broker connectivity goes upstream.** trade-relay never speaks a broker's REST dialect; all of it lives in [`@luxalgo/broker-sdk`](https://github.com/LuxAlgo/broker-sdk), which has its own adapter kit and conformance gate. Want a new broker or order type? Contribute it there — this repo picks it up through the `BrokerPort` seam. PRs here that inline broker HTTP calls will be declined, kindly.
- **Parsers, rails, dashboard, MCP, docs grow here.** A new alert format is a parser + tests. A new rail is a pure function in `risk.ts` + tests + a line in `docs/safety.md`.

## House rules

- **The rails philosophy is non-negotiable:** safety defaults ON; loosening is an explicit flag whose name says what it does; when a rule can't verify a limit it rejects (fail closed); exits stay privileged; nothing is emulated against a real account.
- **Dependencies:** the runtime set is `@luxalgo/broker-sdk`, `@modelcontextprotocol/sdk`, `zod`. Adding a fourth needs a very good story.
- **Files are kebab-case**, code is strict TypeScript, comments explain *why*, tests accompany behavior.
- **Every branch of the pipeline must end in the flight recorder.** If your feature can fail silently, it isn't done.
- **No telemetry.** Not even "anonymous usage stats". Don't ask.

## Sign your commits (DCO)

Every commit needs a Developer Certificate of Origin sign-off (`git commit -s`), certifying [developercertificate.org](https://developercertificate.org/). CI enforces it on pull requests.

## Security

Anything exploitable goes to **security@luxalgo.com**, not the issue tracker — see [SECURITY.md](SECURITY.md).

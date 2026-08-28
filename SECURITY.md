# Security policy

trade-relay touches money. We treat every report seriously.

## Reporting a vulnerability

Email **business@luxalgo.com** with the subject line "SECURITY" plus a
description and, where possible, a reproduction. Please do not open a
public issue for anything exploitable.

You can expect an acknowledgement within 72 hours. We will keep you informed
as we validate and fix, and we will credit you in the release notes unless you
prefer otherwise.

## Scope

- The webhook inlet (authentication, HMAC verification, payload handling).
- The risk engine (anything that lets an order bypass a configured rail).
- The dashboard and REST API (anything reachable without the configured token).
- The MCP surface (anything that lets an agent trade while `mcp.allowTrading`
  is false, or bypass the rails when it is true).
- Credential handling (anything that causes keys to leave the deployment).

## Out of scope

- Vulnerabilities in brokers' own APIs.
- Deployments that consciously disabled the rails or exposed the dashboard
  without auth on a public network (the docs warn against both).

## Design posture

- Broker credentials live only in your deployment's environment variables.
  trade-relay has no server of ours in the path and sends no telemetry.
- Live trading requires an explicit, exact acknowledgement sentence in the
  operator's own config (enforced upstream by `@luxalgo/broker-sdk/orders`);
  paper and sandbox credentials connect without it, and anything that lets a
  live order happen without that sentence is a vulnerability we want to hear
  about.
- Safety rails ship on by default and must be consciously loosened.

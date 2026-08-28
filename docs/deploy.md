# Deploying trade-relay

trade-relay is a single long-running Node process (≥ 22.13) with one SQLite file next to it. Anything that can run that, runs this.

## Docker (any VPS, EC2, DigitalOcean…)

```bash
docker build -t trade-relay .
docker run -d --name trade-relay \
  -p 8484:8484 \
  -v trade-relay-data:/data \
  --env-file .env \
  trade-relay
```

The bundled compose file does the same with a named volume:

```bash
docker compose up -d
```

Config: mount your `trade-relay.config.json` into `/app` or bake a custom image. The image runs `trade-relay init` on first boot if no config exists, so the fastest path is: boot it, copy the generated `.env` secrets out of the container log's instructions, point your alerts at it.

## Railway

Railway detects the Dockerfile. Two clicks:

1. New project → Deploy from GitHub → pick your fork/clone of this repo.
2. Add your env vars (`WEBHOOK_TOKEN`, `DASHBOARD_TOKEN`, broker keys), attach a volume at `/data`.

`railway.json` in the repo pins the health check to `/health`.

## A laptop + a tunnel (fully local)

```bash
npx @luxalgo/trade-relay start
# in another terminal, any tunnel you like:
ngrok http 8484                        # or:
cloudflared tunnel --url http://localhost:8484
```

Point the TradingView alert at the tunnel URL + `/webhook/<token>`. The tool doesn't care which tunnel; it just needs a URL.

## Serverless (Vercel, Lambda)?

Not yet, honestly. The duplicate-protection window, the daily-loss counter, the kill switch, and the SQLite flight recorder all want a persistent process and disk. Storage is behind a driver interface, so a serverless-friendly driver (Postgres/Turso) is a planned follow-up — until then a $5 VPS or the Railway free tier is the honest recommendation, and we'd rather be honest than list a platform that quietly loses your kill switch between invocations.

## Checklist for any deployment

- `WEBHOOK_TOKEN` and `DASHBOARD_TOKEN` are long and random (`openssl rand -hex 24`).
- The SQLite path (`storage.path`) is on a persistent volume.
- HTTPS in front (Railway/tunnels give you this for free; on a bare VPS put Caddy or nginx in front).
- Broker keys are env vars, never in the config file, never in git.
- First run: simulator or paper account, fire a test alert, read the flight recorder, only then wire the real strategy.

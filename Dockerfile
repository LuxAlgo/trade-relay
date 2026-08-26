FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
COPY vendor ./vendor
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build && pnpm prune --prod

FROM node:22-alpine
ENV NODE_ENV=production
# /data holds the config, .env, and the SQLite flight recorder — mount a volume here.
WORKDIR /data
VOLUME /data
COPY --from=build /app/dist /app/dist
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/package.json /app/package.json
EXPOSE 8484
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8484/health || exit 1
# First boot with an empty volume: generate a config + secrets, then run.
ENTRYPOINT ["/bin/sh", "-c", "[ -f trade-relay.config.json ] || node /app/dist/cli.js init; exec node /app/dist/cli.js start"]

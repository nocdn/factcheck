# syntax=docker/dockerfile:1

FROM oven/bun:1-alpine AS deps
WORKDIR /usr/src/app

# bun.lock is tracked in git so the lockfile is present in deploy builds; keep it committed.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-alpine AS release
WORKDIR /usr/src/app

ENV NODE_ENV=production

COPY --from=deps /usr/src/app/node_modules ./node_modules
COPY package.json tsconfig.json README.md ./
COPY src ./src

USER bun
EXPOSE 7110

CMD ["bun", "run", "src/index.ts"]

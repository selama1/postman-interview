# syntax=docker/dockerfile:1.7
# Multi-stage: build with the full workspace, ship only the service's prod deps + dist/.

FROM node:24-alpine AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/service/package.json packages/service/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts
COPY packages/service packages/service
RUN pnpm --filter service build
RUN pnpm --filter service deploy --prod --legacy --ignore-scripts /out

# Test runner: the whole workspace with dev deps, so every test layer runs with only Docker
# installed:  docker compose --profile test run --rm --build tests
# Debian, not Alpine: Playwright's browsers need glibc, so a UI test layer can be added here.
FROM node:24-bookworm-slim AS test
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/service/package.json packages/service/
RUN --mount=type=cache,id=pnpm-test,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts
COPY . .
CMD ["sh", "scripts/test-container.sh"]

# Last stage = default target of a plain `docker build`: the shipped service.
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3000
CMD ["node", "--enable-source-maps", "dist/main.js"]

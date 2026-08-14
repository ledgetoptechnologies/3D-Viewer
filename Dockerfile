# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: fetch a pinned Potree build.
# public/potree/ is intentionally gitignored (large third-party viewer lib
# not owned by this repo) so it has to be fetched at image build time.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS potree
ARG POTREE_VERSION=1.8.2
WORKDIR /tmp
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL -o potree.zip \
      "https://github.com/potree/potree/releases/download/${POTREE_VERSION}/Potree_${POTREE_VERSION}.zip" \
    && mkdir -p extracted && unzip -q potree.zip -d extracted \
    && SRC_DIR="$(dirname "$(find extracted -type d -path '*/build/potree' | head -n1)")" \
    && mkdir -p /potree \
    && cp -r "$SRC_DIR"/. /potree/

# ---------------------------------------------------------------------------
# Stage 2: build the Vite frontend (bundles main.js, copies public/ incl.
# the fetched Potree build into dist/).
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
COPY --from=potree /potree ./public/potree
RUN npx vite build

# ---------------------------------------------------------------------------
# Stage 3: runtime — Node/Express server serves dist/ + the viewer API and
# proxies read-only WebODM assets. No build tools, no dev dependencies.
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY --from=build /app/dist ./dist

EXPOSE 8080
CMD ["node", "server/index.js"]

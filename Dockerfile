# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: fetch a pinned Potree build.
# public/potree/ is intentionally gitignored (large third-party viewer lib
# not owned by this repo) so it has to be fetched at image build time.
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS potree
ARG POTREE_VERSION=1.8.2
ARG POTREE_SHA256=c140a8bce0ce129de762fbc0fd3ba7c21120ffd36d423dd2755abb39f32aebe5
WORKDIR /tmp
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Copy the release root, not just its build/ directory. pointcloud.html loads
# both /potree/build/potree/* and /potree/libs/* at runtime.
RUN curl -fsSL -o potree.zip \
      "https://github.com/potree/potree/releases/download/${POTREE_VERSION}/Potree_${POTREE_VERSION}.zip" \
    && echo "${POTREE_SHA256}  potree.zip" | sha256sum -c - \
    && mkdir -p extracted && unzip -q potree.zip -d extracted \
    && POTREE_BUILD_DIR="$(find extracted -type d -path '*/build/potree' | head -n1)" \
    && test -n "$POTREE_BUILD_DIR" \
    && SRC_DIR="$(dirname "$(dirname "$POTREE_BUILD_DIR")")" \
    && mkdir -p /potree \
    && cp -r "$SRC_DIR"/. /potree/ \
    && test -s /potree/build/potree/potree.js \
    && test -s /potree/libs/jquery/jquery-3.1.1.min.js \
    && test -s /potree/libs/three.js/build/three.min.js \
    && test -s /potree/libs/copc/index.js \
    && test -s /potree/libs/plasio/js/laslaz.js

# ---------------------------------------------------------------------------
# Stage 2: build the Vite frontend (bundles main.js, copies public/ incl.
# the fetched Potree build into dist/).
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS build
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
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupmod --gid 568 node \
    && usermod --uid 568 --gid 568 node
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY scripts ./scripts
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/storage/data /app/storage/datasets /app/storage/models \
      /app/storage/cache /app/storage/trash \
      /app/storage/imports/datasets /app/storage/imports/terra \
    && chown -R 568:568 /app/storage

EXPOSE 8088
USER 568:568
CMD ["node", "server/index.js"]

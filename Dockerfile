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

# Pinned official OpenDroneMap Obj2Tiles release. Release assets are verified
# against the SHA-256 digests published by GitHub before entering the image.
FROM debian:bookworm-slim AS obj2tiles
ARG TARGETARCH
ARG OBJ2TILES_VERSION=1.6.2
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && case "$TARGETARCH" in \
      amd64) asset=Obj2Tiles-Linux64.zip; digest=34a576e0b8ebbd73da5e2271d238724a9b39be3ee1edc167214b5b28bed2baa0 ;; \
      arm64) asset=Obj2Tiles-LinuxArm64.zip; digest=b5252158f81a3d5659a978d1468f7c8915f3794e11359dfeb351e5eeaac48ed5 ;; \
      *) echo "unsupported Obj2Tiles architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /tmp/obj2tiles.zip "https://github.com/OpenDroneMap/Obj2Tiles/releases/download/v${OBJ2TILES_VERSION}/${asset}" \
    && echo "$digest  /tmp/obj2tiles.zip" | sha256sum -c - \
    && mkdir -p /opt/obj2tiles \
    && unzip -q /tmp/obj2tiles.zip -d /opt/obj2tiles \
    && test -x /opt/obj2tiles/Obj2Tiles \
    && /opt/obj2tiles/Obj2Tiles --version 2>&1 | grep -F "${OBJ2TILES_VERSION}" \
    && curl -fsSL -o /opt/obj2tiles/LICENSE.md "https://raw.githubusercontent.com/OpenDroneMap/Obj2Tiles/v${OBJ2TILES_VERSION}/LICENSE.md" \
    && echo "b46d5156399774c9ba728b3d3f93c8ebf8da20dcebd5f67b5cd813aba2ec81cc  /opt/obj2tiles/LICENSE.md" | sha256sum -c -

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
RUN node scripts/patch-potree-ept.mjs public/potree/build/potree/potree.js
RUN npx vite build

# ---------------------------------------------------------------------------
# Stage 3: runtime — Node/Express server serves dist/ + the viewer API and
# proxies read-only WebODM assets. No build tools, no dev dependencies.
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
ARG VIEWER_SOURCE_COMMIT=unknown
ENV NODE_ENV=production
ENV OBJ2TILES_BIN=/opt/obj2tiles/Obj2Tiles
LABEL org.opencontainers.image.revision="${VIEWER_SOURCE_COMMIT}"
WORKDIR /app
RUN groupmod --gid 568 node \
    && usermod --uid 568 --gid 568 node
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY scripts ./scripts
COPY --from=obj2tiles /opt/obj2tiles /opt/obj2tiles
COPY --from=build /app/dist ./dist
RUN printf '%s\n' "${VIEWER_SOURCE_COMMIT}" > /app/source-commit.txt \
    && chmod 0444 /app/source-commit.txt \
    && mkdir -p /app/storage/data /app/storage/datasets /app/storage/models \
      /app/storage/cache /app/storage/trash \
      /app/storage/imports/datasets /app/storage/imports/terra \
    && chown -R 568:568 /app/storage

EXPOSE 8088
USER 568:568
CMD ["node", "server/index.js"]

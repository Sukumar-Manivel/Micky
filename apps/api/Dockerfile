# Micky API image. ONE image runs three commands:
#   API (default):  node dist/main.js
#   Worker:         node dist/worker.js
#   Migrations:     node dist/db/migrate.js
#   Seed admin:     node dist/db/seed.js
#
# Builds for linux/amd64 and linux/arm64 (Oracle Ampere). No native npm modules
# are used (bcryptjs, pg, ioredis are pure JS), so Alpine/musl is safe.
#
#   docker build -t micky-api apps/api

ARG NODE_VERSION=22

# ---------- 1. deps: every dependency, for compiling ----------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# The cache mount keeps npm's download cache between builds (not in the image).
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ---------- 2. build: TypeScript -> dist/ ----------
FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npx nest build

# ---------- 3. prod-deps: runtime dependencies only ----------
FROM node:${NODE_VERSION}-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# ---------- 4. runtime ----------
FROM node:${NODE_VERSION}-alpine AS runtime

# ffmpeg + ffprobe: previews, frames, metadata (src/processing/ffmpeg.ts)
# fontconfig + font-dejavu: `fc-match "DejaVu Sans:bold"` finds the watermark font
# tini: PID 1 that forwards signals and reaps ffmpeg child processes
# Versions come from the Alpine release of the pinned node image; Alpine removes
# old package versions, so exact apk pins would break rebuilds.
# hadolint ignore=DL3018
RUN apk add --no-cache ffmpeg fontconfig font-dejavu tini \
    && fc-cache -f

ENV NODE_ENV=production \
    PORT=4000 \
    STORAGE_LOCAL_DIR=/data/storage \
    UPLOAD_TMP_DIR=/data/tmp/uploads \
    TMPDIR=/data/tmp \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app

# The `node` user (uid 1000) ships with the official image. /data is the volume
# for originals, previews (when STORAGE_DRIVER=local), uploads in progress and
# ffmpeg work dirs, so large temp files never fill the container's layer.
RUN mkdir -p /data/storage /data/tmp/uploads && chown -R node:node /data

COPY --chown=node:node package.json ./
COPY --chown=node:node --from=prod-deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
# dist/db/migrate.js reads SQL migrations from ../../drizzle (= /app/drizzle)
COPY --chown=node:node drizzle ./drizzle

# uid 1000 = the `node` user of the official image (numeric, so Kubernetes
# runAsNonRoot and file ownership on volumes are unambiguous)
USER 1000:1000
VOLUME ["/data"]
EXPOSE 4000

# Checks the API (and its database connection). The worker container runs the
# same image with a different command, so compose disables this check there.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]

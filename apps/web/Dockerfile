# FirstFrame web app (Next.js PWA). Builds for linux/amd64 and linux/arm64.
#
#   docker build -t firstframe-web apps/web
#   docker run -p 3000:3000 -e PUBLIC_API_URL=https://api.example.com firstframe-web
#
# Where the browser finds the API:
#   PUBLIC_API_URL (runtime, preferred): set on the container; served to the browser by
#     /runtime-config.js, so ONE image works for every domain.
#   NEXT_PUBLIC_API_URL (build arg, optional fallback): inlined into the JavaScript
#     bundle at build time; used only when PUBLIC_API_URL is not set.
#
# Best with `output: 'standalone'` in next.config.ts: the image then ships only
# the files Next.js traced (~100 MB smaller). Without it, the image falls back
# to production node_modules + `next start`, so the Dockerfile works either way.

ARG NODE_VERSION=22

# ---------- 1. deps ----------
FROM node:${NODE_VERSION}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ---------- 2. build ----------
FROM deps AS build
ARG NEXT_PUBLIC_API_URL=""
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production
COPY . .
RUN npm run build

# Assemble /out with exactly what the runtime needs, in either output mode.
RUN set -eux; \
    mkdir -p /out; \
    if [ -f .next/standalone/server.js ]; then \
      echo "Using standalone output"; \
      cp -a .next/standalone/. /out/; \
      mkdir -p /out/.next; \
      cp -a .next/static /out/.next/static; \
      cp -a public /out/public; \
    else \
      echo "standalone output not enabled: falling back to next start"; \
      npm prune --omit=dev --no-audit --no-fund; \
      cp -a package.json next.config.ts node_modules public /out/; \
      mkdir -p /out/.next; \
      cp -a .next/. /out/.next/; \
      rm -rf /out/.next/cache; \
    fi

# ---------- 3. runtime ----------
FROM node:${NODE_VERSION}-alpine AS runtime
# Versions come from the Alpine release of the pinned node image; Alpine removes
# old package versions, so exact apk pins would break rebuilds.
# hadolint ignore=DL3018
RUN apk add --no-cache tini
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /out ./
# uid 1000 = the `node` user of the official image (numeric, so Kubernetes
# runAsNonRoot and file ownership on volumes are unambiguous)
USER 1000:1000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "if [ -f server.js ]; then exec node server.js; else exec node node_modules/next/dist/bin/next start; fi"]

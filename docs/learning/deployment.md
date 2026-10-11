# Deployment, explained

How FirstFrame goes from code on a laptop to a live HTTPS site on one free Oracle VM, and why each piece is there. The step-by-step guide is `docs/DEPLOYMENT.md`. This file is for understanding it well enough to explain it in an interview.

## What was built and why

| File | Job |
|---|---|
| `apps/api/Dockerfile` | One image for the API, the worker, migrations and the seed script. Includes ffmpeg and fonts |
| `apps/web/Dockerfile` | Next.js in standalone mode (~46 MB of app files instead of ~440 MB) |
| `services/verifier/Dockerfile` | Python + CPU-only PyTorch, model baked in (written by the verifier builder) |
| `docker-compose.yml` | The whole stack on a laptop, one command |
| `infra/docker-compose.prod.yml` | The production stack: Caddy, memory limits, restart policies, private network |
| `infra/Caddyfile` | HTTPS certificates and routing for the web and API domains |
| `infra/.env.prod.example` | Every production setting, and how to generate each secret |
| `scripts/deploy.sh` | On the VM: pull → migrate → restart → wait for health |
| `scripts/backup-db.sh`, `restore-db.sh` | Nightly `pg_dump` to Cloudflare R2, and the way back |
| `scripts/server-setup.sh` | Turns a fresh Ubuntu VM into a Docker host (firewall, swap, cron) |
| `.github/workflows/ci.yml` | Tests every push and pull request |
| `.github/workflows/deploy.yml` | Builds multi-arch images, pushes to ghcr.io, deploys over SSH |

The constraint behind every choice: **₹0 a month**. One Oracle Always Free Arm VM (2 cores, 12 GB RAM, 200 GB disk) runs everything.

## The journey of a commit

```
git push main
  └─ deploy.yml
       ├─ ci.yml (reused): api lint/typecheck/unit/e2e · web lint/typecheck/test/build · verifier ruff/pytest · compose/shellcheck · docker builds
       ├─ build ×6: {api, web, verifier} × {amd64 runner, arm64 runner} → push by digest to ghcr.io
       ├─ manifest ×3: join the two digests into one multi-arch tag: :<sha> and :latest
       └─ deploy: scp compose + Caddyfile + scripts → ssh "scripts/deploy.sh <sha>"
                    └─ on the VM: set IMAGE_TAG=<sha> in .env → compose pull → run migrate
                                  → compose up -d (only changed containers restart)
                                  → reload Caddy → wait until api is "healthy" → prune old images
```

And a request once it's live:

```
Phone ─HTTPS─▶ api.firstframe.in (DNS → VM IP) ─▶ Caddy :443 (TLS ends here)
             ─HTTP─▶ api:4000 (Docker network "edge") ─▶ NestJS ─▶ postgres:5432 / redis:6379 (network "backend", internal)
```

## Key concepts

### Image vs container

- An **image** is a read-only, layered snapshot of a filesystem plus metadata: the default command, environment variables, the user to run as and the exposed port. `firstframe-api:3f2c1ab` is an image. Think of it as a class.
- A **container** is a running (or stopped) instance of an image. It gets its own thin writable layer, process namespace and network interface. `api` and `worker` are two containers from the **same** image with different commands. Think of them as two objects of the same class.
- Containers are disposable: anything written inside one disappears when it's recreated. Data that must survive lives in **volumes** (`pgdata`, `mediadata`, `caddy_data`).

### Layers and caching

Each Dockerfile instruction creates a layer, and Docker reuses a cached layer if its inputs haven't changed. That is why the Dockerfiles copy `package.json` + `package-lock.json` and run `npm ci` **before** copying the source: editing a `.ts` file doesn't reinstall 400 packages. `RUN --mount=type=cache,target=/root/.npm` keeps npm's download cache between builds without putting it in the image. In CI, `cache-from/cache-to: type=gha` stores these layers in GitHub's cache.

### Multi-stage builds

A Dockerfile can have several `FROM` stages. Later stages copy only what they need from earlier ones (`COPY --from=build`).

- The API image has four stages:
  1. **deps:** every dependency, for compiling.
  2. **build:** TypeScript compiled to `dist/`.
  3. **prod-deps:** `npm ci --omit=dev`.
  4. **runtime:** Alpine + ffmpeg + `dist` + production `node_modules`.
  The TypeScript compiler, Nest CLI, test tools and source code never reach production. The result is smaller, faster to pull, and has less attack surface (fewer packages that could have vulnerabilities).
- For the web image, `output: 'standalone'` makes Next.js trace exactly which files the server needs. The runtime is `server.js` + the traced files + static assets.

### Small, safe runtime images

- **Non-root:** `USER 1000:1000`. If someone finds a bug in an image decoder, they are an unprivileged user, not root in the container.
- **tini as PID 1:** forwards `SIGTERM` to Node (so NestJS shuts down cleanly) and reaps zombie `ffmpeg` processes.
- **HEALTHCHECK:** Docker runs `GET /api/v1/health` every 30 s. That endpoint runs `select 1` against Postgres. `deploy.sh` waits for `healthy`, so a broken release fails the deploy instead of going unnoticed.
- **`.dockerignore`:** keeps `node_modules`, `.env` files and test data out of the build context. Leaking `.env` into an image layer is a classic mistake: layers are forever, even if a later layer deletes the file.

### Multi-arch images

The VM is **Arm (aarch64)**; most laptops and CI runners are **x86-64 (amd64)**. An image built for one CPU fails on the other with `exec format error`. `deploy.yml`:
1. Builds each image on a native amd64 runner and a native arm64 runner. Emulating Arm with QEMU works but is 5–10× slower, which is painful for PyTorch.
2. Pushes each by digest.
3. Joins them into one **manifest list** with `docker buildx imagetools create`.

`docker pull` then picks the right architecture automatically.

### Docker Compose

Compose describes several containers, their networks, volumes, environment and start-up order in one YAML file.

- **Service names are DNS names:** the API reaches the database at `postgres:5432`.
- **`depends_on` with conditions:** `api` waits for `migrate` to finish successfully (`service_completed_successfully`) and for Redis to be `service_healthy`.
- **One-shot services:** `migrate` runs and exits; `seed` sits behind a `profile` so it only runs on demand (`docker compose run --rm seed`).
- **Two networks:**
  - `edge` holds Caddy, web, api and worker. It has internet access, which the API needs for R2 and Razorpay.
  - `backend` is `internal: true`. It holds postgres, redis, the verifier, api, worker and migrate, and has **no route to the internet and no published ports**.

  A misconfigured database can't be reached from outside, and a compromised verifier can't phone home.
- **Limits:** `deploy.resources.limits.memory` caps each container. On a 12 GB machine, an ffmpeg job that runs away is killed alone, instead of the kernel's OOM killer picking Postgres.
- **Restart policy:** `unless-stopped` restarts crashed containers and starts everything after a reboot.
- **Log rotation:** `max-size: 10m, max-file: 3` per container, so logs can't fill the disk.

### Reverse proxy and TLS

A **reverse proxy** sits in front of the apps and forwards requests to them. Caddy:
- Terminates **TLS** (HTTPS) and gets/renews free **Let's Encrypt** certificates automatically. It proves it controls the domain by answering an HTTP-01 challenge on port 80.
- Routes by host name: `WEB_DOMAIN` → `web:3000`, `API_DOMAIN` → `api:4000`.
- Upgrades **WebSocket** connections for Socket.IO (`/socket.io/*`) transparently. `flush_interval -1` stops long-polling responses from being buffered.
- Adds security headers (HSTS, nosniff, frame-deny) only where the app didn't already set them, and compresses JSON/HTML.
- Sets `X-Forwarded-For`. NestJS uses `app.set('trust proxy', 1)` to trust exactly one hop (Caddy), so rate limiting sees the real client IP instead of Caddy's.

Why **Cloudflare DNS-only for the API**? The free Cloudflare proxy caps request bodies at 100 MB (videos go up to 500 MB) and its terms restrict serving video. The web app can sit behind Cloudflare's proxy/CDN. The API talks to clients directly, with Caddy's certificate.

### Configuration and secrets

- **12-factor config:** the same image runs anywhere; only environment variables change. The API reads them once into a typed `AppConfig` and **refuses to start** if a production secret is missing or under 32 characters, or if payments are set to `mock`. Failing at start-up is far better than failing on the first payment.
- **Where secrets live:**

  | Where | What | Notes |
  |---|---|---|
  | `/opt/firstframe/.env` on the VM | app secrets | `chmod 600`, never in Git |
  | GitHub environment secrets | SSH key, host | only the `deploy` job, in the `production` environment, can read them |
  | `GITHUB_TOKEN` | registry push/pull | created per run, expires when the job ends |

- **Least privilege in CI:**
  - Workflows default to `permissions: {}` or `contents: read`.
  - Only the build jobs get `packages: write`.
  - `persist-credentials: false` stops checkout from leaving a token in `.git/config`.
- **Build-time vs run-time config:** Next.js inlines `NEXT_PUBLIC_*` variables into browser JavaScript at **build** time, so an image built that way only works for one API address (and a secret put there is public). The web app avoids that: the container's `PUBLIC_API_URL` is served to the browser at runtime by `/runtime-config.js`, so **one image** runs on staging, production or a laptop. `NEXT_PUBLIC_API_URL` stays only as a build-time fallback. The rule "build once, configure per environment" is what makes promoting the exact tested image possible.
- **Hardening ideas:**
  - Move `BACKUP_S3_*` keys to a separate file that only the backup script reads; the app containers don't need them.
  - Use Docker secrets or SOPS-encrypted files.
  - Rotate the R2 token and deploy key yearly.

### CI vs CD

- **Continuous Integration:** every change is automatically built and tested (lint, typecheck, unit tests, e2e tests against real Postgres/Redis service containers, image builds), so `main` is always releasable.
- **Continuous Delivery/Deployment:** every change that passes CI is automatically packaged (images tagged with the commit SHA) and deployed.
- Here, `deploy.yml` **calls** `ci.yml` as a reusable workflow. Nothing is deployed unless the same tests pass, and `main` isn't tested twice.
- Tagging images with the **commit SHA** makes deploys reproducible and rollbacks trivial: `deploy.sh <old-sha>`.

### Database migrations in a deploy

Migrations run **before** the new containers start (`compose run --rm migrate`), while the old API is still serving. So every migration must work with **both** the old and the new code ("expand and contract"):
1. Add the new column (nullable or with a default).
2. Deploy code that writes both the old and new columns.
3. Backfill.
4. Deploy code that reads only the new column.
5. Drop the old column in a later release.

Renaming a column in one step would break the old API for the seconds the deploy takes.

### Backups

- **What:** the database (a logical `pg_dump` in plain SQL, gzipped). Postgres holds the money ledger, users and orders, so this matters most.
- **Where:**
  - On the VM (fast restores).
  - **Off the VM** in Cloudflare R2, so losing the VM, disk or account doesn't lose the data.
  - The R2 token can only touch the backup bucket.
- **How long:** 14 days, pruned by the script (`rclone delete --min-age 14d`), with an R2 lifecycle rule as a safety net.
- **Safety:**
  - `flock` prevents overlapping runs.
  - `gzip -t` and a size check catch empty or broken dumps.
  - `umask 077` keeps dumps private.
  - The restore takes a safety dump first and loads in a single transaction.
- **The 3-2-1 rule:** 3 copies, 2 kinds of media, 1 off-site. We have the live DB, a local dump and an R2 copy.
- **The gap, stated honestly:** media files are not in the nightly backup (too large for R2's free 10 GB). Use Oracle's free volume backups monthly, or move media to R2 (`STORAGE_DRIVER=s3`) once there's budget.
- **RPO/RTO:**
  - RPO (how much data you can lose): up to 24 hours.
  - RTO (how long recovery takes): about 15 minutes on a ready VM.
  - Continuous WAL archiving (e.g. pgBackRest or WAL-G to R2) would bring the RPO down to minutes.

### Zero-downtime considerations

With one VM and one API container there is a short gap while the new container starts. What we do about it:
- Only containers whose image changed are recreated.
- Socket.IO clients reconnect by themselves.
- Uploads in progress during a restart fail and must be retried, which is why deploys are not run during peak hours.

What true zero downtime needs:
- **Two API replicas** behind the proxy, with health-checked rolling replacement (start new → wait healthy → stop old). Caddy's `reverse_proxy` can load-balance and health-check several upstreams. Tools like Docker Swarm, Kubernetes, Kamal or `docker-rollout` automate it.
- **Graceful shutdown:** stop accepting new requests, finish in-flight ones (`enableShutdownHooks`, `stop_grace_period`). BullMQ returns an unfinished job to the queue if a worker dies.
- **Backward-compatible migrations** (above), and sticky sessions or a Redis adapter for WebSockets once there are several API instances.

### How this would scale beyond one VM

In order, as load grows:

1. **Vertical first:** a bigger VM. Cheapest and simplest.
2. **Move state out of the box:**
   - Media to object storage (`STORAGE_DRIVER=s3`).
   - Postgres to a managed service with automated backups and point-in-time recovery.
   - Redis to a managed instance.
   Now the app servers are **stateless**.
3. **Horizontal app tier:**
   - Several API containers behind a load balancer.
   - The **Socket.IO Redis adapter**, so a live alert emitted on one API instance reaches clients connected to another.
   - Rate limits stored in Redis instead of memory.
4. **Separate the worker pool:** ffmpeg is CPU-heavy, so run workers on their own (possibly autoscaled or spot) machines. They pull jobs from the shared Redis queue; more workers means more throughput, with no code change.
5. **Verifier on a GPU or a separate service** with its own autoscaling.
6. **CDN for previews:** a paid video product (e.g. Cloudflare Stream) or signed URLs straight from object storage, so video bytes stop flowing through the API.
7. **Orchestration:** Kubernetes or a managed container platform for rolling deploys, autoscaling and self-healing. Add observability (metrics, traces, central logs) before you need it.

## Trade-offs we made

| Choice | Benefit | Cost |
|---|---|---|
| One VM, Docker Compose | Free, simple, easy to reason about | Single point of failure; brief downtime on deploy |
| Media on local disk | 200 GB free vs 10 GB in R2 | Not in the nightly backup; the VM holds state |
| Caddy instead of Nginx + certbot | Automatic HTTPS in a 60-line file | Fewer tutorials for advanced cases |
| API not behind Cloudflare | 500 MB uploads, no video-terms risk | No CDN/DDoS shield for the API |
| Alpine base images | Small images | musl libc: fine here (no native npm modules), but can bite with native addons |
| Build per-arch on native runners | Fast, reliable Arm builds | Six build jobs instead of one; private repos pay Arm minutes |
| `pg_dump` nightly | Simple, portable, easy restores | Up to 24 h of data loss |
| GitHub `GITHUB_TOKEN` for the VM's pull | No long-lived registry password on the server | Manual pulls of private images need your own token |

## Interview questions with model answers

**1. What's the difference between a Docker image and a container?**
An image is an immutable, layered template: a filesystem plus metadata like the default command and user. A container is a running instance of an image with its own writable layer, process space and network. In FirstFrame the `api` and `worker` containers come from the same image with different commands. Containers are disposable, so persistent data goes in volumes.

**2. Why use multi-stage builds?**
To separate the build environment from the runtime. Compilers, dev dependencies and source stay in earlier stages; the final stage copies only build output and production dependencies. Images get smaller (faster pulls on a small VM), have fewer vulnerable packages, and leak no source or build secrets.

**3. How do you keep Docker builds fast?**
Order instructions from least to most frequently changing. Copy the lockfile and install dependencies before copying source, so code edits reuse the dependency layer. Use BuildKit cache mounts for package-manager caches, a remote layer cache in CI (`type=gha`), and a `.dockerignore` to keep the build context small.

**4. Why run containers as a non-root user, and what is tini for?**
If an attacker exploits the app (say, a malformed video in ffmpeg), they get an unprivileged user, not root, which limits what they can modify or escape to. tini is a minimal init: as PID 1 it forwards signals like SIGTERM so the app shuts down gracefully, and it reaps zombie child processes such as finished ffmpeg runs.

**5. What does a reverse proxy do here, and how does HTTPS get set up?**
Caddy receives all traffic on 80/443, terminates TLS, routes by host name to the web or API container, handles WebSocket upgrades for Socket.IO and adds security headers. It obtains Let's Encrypt certificates automatically via the ACME HTTP-01 challenge, proving control of the domain by serving a token on port 80, and renews them before expiry. Certificates live in a volume so restarts don't trigger re-issuance and rate limits.

**6. The app is behind a proxy. How does it know the client's real IP, and why does it matter?**
The proxy adds `X-Forwarded-For`. The app must trust exactly the proxies it actually has (`trust proxy 1`). Trust too few and every request looks like it came from Caddy, so one abuser rate-limits everyone. Trust too many and clients can spoof the header to dodge limits.

**7. Explain CI vs CD in this project.**
CI runs on every push and pull request: lint, typecheck, unit tests, e2e tests against real Postgres and Redis service containers, and image builds. It keeps `main` releasable. CD runs on merge to `main`. It reuses the CI workflow, builds multi-arch images tagged with the commit SHA, pushes them to the registry and deploys them over SSH, with a health check at the end. A failure at any step stops the release.

**8. How are secrets handled?**
They never go in Git or images. On the server they live in a `chmod 600` `.env`; in GitHub, deploy SSH credentials are environment secrets visible only to the deploy job. Registry access uses the per-run `GITHUB_TOKEN`, which expires with the job. Workflow permissions are least-privilege (`contents: read` by default, `packages: write` only for builds). The app validates secrets at start-up and refuses weak ones. Anything `NEXT_PUBLIC_*` is public by design, because it's compiled into browser code.

**9. How do you run database migrations safely during a deploy?**
Run them as a separate one-shot step before starting the new code, and make them backward compatible, because the old version is still running against the migrated schema. Use expand-and-contract: add new structures, deploy code that uses them, backfill, and remove old structures in a later release. Never rename or drop in the same release that stops using something.

**10. How would you roll back a bad release?**
Images are tagged with the commit SHA and old tags stay in the registry, so a rollback is `deploy.sh <previous-sha>` (or re-running the workflow with that tag). It pulls the old images and recreates the containers. Because migrations are backward compatible, the old code still works with the newer schema. If data was corrupted, restore the database from the last backup.

**11. Describe your backup strategy. What are RPO and RTO?**
A nightly `pg_dump`, gzipped, checked for integrity, kept locally and copied off-site to Cloudflare R2 with 14-day retention. The R2 token is scoped to that bucket only. Restores are scripted and practised. RPO (recovery point objective) is how much data you can lose: up to 24 hours here. RTO (recovery time objective) is how long recovery takes: about 15 minutes. Continuous WAL archiving would cut the RPO to minutes.

**12. How do you build images for an Arm server from x86 CI?**
Either emulate Arm with QEMU via `docker buildx --platform linux/arm64` (simple but slow), or build natively on Arm runners. We build each architecture on its own native runner, push by digest, then combine them into one multi-arch manifest list so `docker pull` picks the right one on any machine.

**13. Why are Postgres and Redis not exposed, and how do you reach them for maintenance?**
Exposed databases get scanned and brute-forced within minutes. They sit on an internal Docker network with no published ports, reachable only by the containers that need them. For maintenance, SSH to the VM and run `docker compose exec postgres psql`, or use an SSH tunnel.

**14. What breaks first as traffic grows, and how would you scale?**
On a 2-core VM, the CPU-heavy ffmpeg processing queue is the first bottleneck, then disk for media. Scale vertically first. Then move state out (object storage for media, managed Postgres and Redis) so app servers become stateless. Then run several API instances behind a load balancer with the Socket.IO Redis adapter, and a separate autoscaled worker pool consuming the shared Redis queue. Finally, an orchestrator such as Kubernetes for rolling deploys and autoscaling.

**15. How would you get zero-downtime deploys?**
Run at least two replicas behind a health-checking load balancer. Replace them one at a time: start the new one, wait for its health check, drain and stop the old one. Shut down gracefully so in-flight requests and jobs finish or are re-queued. Keep migrations backward compatible so old and new versions can run side by side during the rollout.

**16. What is a Docker healthcheck, and how did you use it?**
A command Docker runs periodically inside the container. Its exit code marks the container `healthy` or `unhealthy`. The API's checks `GET /api/v1/health`, which pings the database. Compose uses health to order start-up (`service_healthy`), and the deploy script waits for `healthy` before declaring success. The worker container shares the API image but serves no HTTP, so its healthcheck is disabled explicitly.

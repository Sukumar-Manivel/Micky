# Deployment, explained

How Micky goes from code on a laptop to a live HTTPS site on one free Oracle VM, and why each piece is there. The step-by-step guide is `docs/DEPLOYMENT.md`. This file is for understanding it well enough to explain it in an interview.

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
       └─ deploy: ssh vm ff-upload  (tar of compose + Caddyfile on stdin)
                  ssh vm "ff-deploy <sha> <user>"  (registry token on stdin)
                    └─ the VM's forced command (deploy-gate) checks each request, then:
                       set IMAGE_TAG=<sha> in .env → compose pull → run migrate
                                  → compose up -d (only changed containers restart)
                                  → reload Caddy → wait until api is "healthy" → prune old images
```

And a request once it's live:

```
Phone ─HTTPS─▶ api.micky.in (DNS → VM IP) ─▶ Caddy :443 (TLS ends here)
             ─HTTP─▶ api:4000 (Docker network "edge") ─▶ NestJS ─▶ postgres:5432 / redis:6379 (network "backend", internal)
```

## Key concepts

### Image vs container

- An **image** is a read-only, layered snapshot of a filesystem plus metadata: the default command, environment variables, the user to run as and the exposed port. `micky-api:3f2c1ab` is an image. Think of it as a class.
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
  | `/opt/micky/.env` on the VM | app secrets | `chmod 600`, never in Git |
  | GitHub environment secrets | SSH key, host | only the `deploy` job, in the `production` environment, can read them |
  | `GITHUB_TOKEN` | registry push/pull | created per run, expires when the job ends |

- **Least privilege in CI:**
  - Workflows default to `permissions: {}` or `contents: read`.
  - Only the build jobs get `packages: write`.
  - `persist-credentials: false` stops checkout from leaving a token in `.git/config`.
- **Supply chain (review finding L9):**
  - Every third-party action is pinned to a **full commit SHA**, with the version in a comment (`actions/checkout@fbc6f39… # v5.1.0`). A tag like `v5` can be moved by whoever controls that repository, so the code that runs with our `packages: write` token could change under us. A SHA cannot.
  - Pinning only helps if you keep updating, so `.github/dependabot.yml` proposes weekly PRs for actions, npm, pip and base images. Each PR runs the full CI.
  - `SSH_KNOWN_HOSTS` is **required**. The old fallback (`ssh-keyscan` at deploy time) trusted whatever answered, which is exactly what a man-in-the-middle wants.
  - The deploy key is pinned to a **forced command** on the server (`command="/usr/local/sbin/micky-deploy-gate",restrict` in `authorized_keys`). The deploy user is in the `docker` group, which is root-equivalent, so the key used to be a root key. Now it can do two things:
    - upload a compose file and Caddyfile, which are rejected if they use other images, `privileged`, host namespaces, extra capabilities or bind mounts;
    - deploy a tag.
    The gate is root-owned and outside `/opt/micky`, so the key can't rewrite it. Residual risk: someone with both the key and push access to our registry can still run their image.
- **Build-time vs run-time config:** Next.js inlines `NEXT_PUBLIC_*` variables into browser JavaScript at **build** time, so an image built that way only works for one API address (and a secret put there is public). The web app avoids that: the container's `PUBLIC_API_URL` is served to the browser at runtime by `/runtime-config.js`, so **one image** runs on staging, production or a laptop. `NEXT_PUBLIC_API_URL` stays only as a build-time fallback. The rule "build once, configure per environment" is what makes promoting the exact tested image possible.
- **Each container gets only its own secrets** (review finding L3). There is no `env_file: .env`: `docker-compose.yml` lists, per service, exactly the variables it needs.
  - `api`: the JWT and signing secrets and the Razorpay keys.
  - `worker`: only `INTERNAL_TOKEN` (to call the verifier).
  - `migrate`: only `DATABASE_URL`.
  - The backup keys (`BACKUP_*`), `ADMIN_PASSWORD` and `POSTGRES_PASSWORD` never enter an app container; the backup scripts on the host read them.

  `AppConfig` knows which process it is (`APP_ROLE=api|worker`) and requires only that process's secrets in production. A secret the process doesn't need becomes a random value, never a guessable default, so an accidental use fails closed.
- **Network isolation follows the same idea.** The worker parses untrusted video with ffmpeg, the riskiest code we run. It sits only on the internal `backend` network: no internet, no route to Caddy. If an ffmpeg exploit ever lands, there is nowhere to send data. (With `STORAGE_DRIVER=s3` it needs R2, so it would also join `edge`.)
- **Hardening ideas still open:** Docker secrets or SOPS-encrypted files instead of a plain `.env`; yearly rotation of the R2 token and the deploy key.

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

- **What:**
  - The database: a logical `pg_dump`, gzipped, then **encrypted**. Postgres holds the money ledger, users, password hashes, UPI IDs and GPS metadata, so this matters most.
  - **Sold originals**: footage a newsroom has paid for, which we owe someone.
- **Encryption with a public key (review finding M7).** Backups are encrypted on the server with [age](https://age-encryption.org) to a **public** key (`BACKUP_AGE_RECIPIENTS`). The private key lives off the server: a password manager plus a second copy. So:
  - a leaked R2 token reveals nothing;
  - a compromised VM can write new backups but cannot read old ones;
  - the plaintext only ever exists inside a pipe (`pg_dump | gzip | age > file`).
  The cost: the server can't test-decrypt its own backup, which is why restores must be practised. `make test-backups` runs the whole round trip locally and in CI.
- **Where:**
  - On the VM, for fast restores.
  - **Off the VM** in Cloudflare R2, so losing the VM, disk or account doesn't lose the data.
  - The R2 token can only touch the backup bucket. An **R2 bucket lock** stops anyone, a compromised server included, deleting dumps early. A lifecycle rule expires them after 30 days, so the script no longer needs to delete anything remotely.
- **Media, within the free tier.** R2 is free up to 10 GB, while the VM can hold about 150 GB of media, so not everything fits.
  - `backup-media.sh` uploads every **sold** original (age-encrypted, streamed with `age | rclone rcat`, no temp file).
  - It uses an upload-then-rename, so a failed read never leaves a truncated object that looks backed up.
  - It refuses to go over `BACKUP_MEDIA_MAX_GB` (default 8 GB).
  - Previews are rebuildable from originals, so they're skipped.
  - Unsold originals are covered only by Oracle's monthly boot-volume backup. That is the honest gap.
- **Safety:**
  - `flock` prevents overlapping runs.
  - A size check and an age-header check catch empty or broken dumps.
  - The restore decrypts and gzip-tests **before** touching the live database, takes a safety dump first, and loads in a single transaction.
  - age authenticates the data, so a tampered or truncated file fails at decryption.
  - The scripts fail loudly when the database query or the bucket listing fails. A silent "0 files to back up" is the worst kind of backup bug.
- **The 3-2-1 rule:** 3 copies, 2 kinds of media, 1 off-site. We have the live DB, a local dump and an R2 copy.
- **RPO/RTO:**
  - RPO (how much data you can lose): up to 24 hours.
  - RTO (how long recovery takes): about 15 minutes on a ready VM, plus fetching the private key.
  - Continuous WAL archiving (e.g. pgBackRest or WAL-G to R2) would bring the RPO down to minutes.

## Trade-offs we made

| Choice | Benefit | Cost |
|---|---|---|
| One VM, Docker Compose | Free, simple, easy to reason about | Single point of failure; brief downtime on deploy |
| Media on local disk | 200 GB free vs 10 GB in R2 | Only sold originals go off-site (size cap); the VM holds state |
| age public-key backups | Server and R2 leaks can't read backups | Lose the private key and every backup is useless; keep two copies |
| Forced-command deploy key | A stolen key can't get a shell | Script changes need a manual copy with your own key |
| Actions pinned to SHAs | Upstream tag moves can't change our CI | Needs Dependabot PRs to stay current |
| Caddy instead of Nginx + certbot | Automatic HTTPS in a 60-line file | Fewer tutorials for advanced cases |
| API not behind Cloudflare | 500 MB uploads, no video-terms risk | No CDN/DDoS shield for the API |
| Alpine base images | Small images | musl libc: fine here (no native npm modules), but can bite with native addons |
| Build per-arch on native runners | Fast, reliable Arm builds | Six build jobs instead of one; private repos pay Arm minutes |
| `pg_dump` nightly | Simple, portable, easy restores | Up to 24 h of data loss |
| GitHub `GITHUB_TOKEN` for the VM's pull | No long-lived registry password on the server | Manual pulls of private images need your own token |

## Interview questions with model answers

**1. What's the difference between a Docker image and a container?**
An image is an immutable, layered template: a filesystem plus metadata like the default command and user. A container is a running instance of an image with its own writable layer, process space and network. In Micky the `api` and `worker` containers come from the same image with different commands. Containers are disposable, so persistent data goes in volumes.

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
A nightly `pg_dump`, gzipped and encrypted with age to a public key whose private half is kept off the server. It's kept locally and copied off-site to Cloudflare R2, protected by a bucket lock and expired by a lifecycle rule. Sold originals go to R2 the same way, under a size cap that keeps us in the free tier. Restores are scripted and tested in CI. RPO (recovery point objective) is how much data you can lose: up to 24 hours here. RTO (recovery time objective) is how long recovery takes: about 15 minutes. Continuous WAL archiving would cut the RPO to minutes.

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

**17. Why encrypt backups to a public key instead of with a password stored on the server?**
Because the threat model includes the server. If the password sits next to the backups, whoever compromises the server, or reads its `.env`, can decrypt every backup. With a public key the server can only encrypt. Decryption needs the private key, which never lives there. The trade-offs: the server can't verify its own backups by decrypting them (so restores are practised and tested in CI), and losing the private key loses every backup, so it's kept in two places.

**18. Why pin GitHub Actions to commit SHAs?**
A tag such as `v5` is a movable pointer. If the action's repository is compromised, the attacker can move the tag, and our workflow, holding a `packages: write` token, runs their code on the next push. A full SHA is immutable. Pinning creates update work, so Dependabot opens PRs that bump the SHA and the version comment together, and CI tests each one.

**19. Your deploy user is in the docker group. Why is that a problem, and what did you do?**
Access to the Docker socket is root-equivalent: `docker run -v /:/host` reads or writes anything. So the CI deploy key was effectively a root key. We pinned it to a forced command in `authorized_keys`. Whatever the client asks for, the server runs our gate script, which accepts only "upload these two config files" (after checking the images, privileges and mounts they ask for) and "deploy this tag". The gate is root-owned so the key can't replace it. The remaining risk is someone who holds the key and can also push images to our registry.

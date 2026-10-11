# Deploying FirstFrame for ₹0 a month

This guide takes you from nothing to a live FirstFrame on the internet, with HTTPS, automatic deploys from GitHub and nightly backups. Every command is meant to be copied and pasted. Replace the placeholders in `<ANGLE_BRACKETS>`.

| Placeholder | Example | Meaning |
|---|---|---|
| `<VM_IP>` | `140.238.10.20` | Your Oracle VM's public IP |
| `<WEB_DOMAIN>` | `firstframe.in` | Address of the web app |
| `<API_DOMAIN>` | `api.firstframe.in` | Address of the API |
| `<GH_USER>/<REPO>` | `asha/firstframe` | Your GitHub repository |

> Limits below were checked on **11 October 2026**. Free tiers change: re-check the linked pages before you rely on a number.

---

## 0. What runs where

```
 Browser ──HTTPS──▶ Cloudflare DNS ──▶ Oracle VM (Ubuntu, arm64, Docker Compose)
                                        ├─ caddy     :80/:443  TLS certificates + reverse proxy
                                        ├─ web       Next.js            (edge network)
                                        ├─ api       NestJS             (edge + backend)
                                        ├─ worker    NestJS + ffmpeg    (edge + backend)
                                        ├─ verifier  FastAPI + PyTorch  (backend only)
                                        ├─ postgres  PostgreSQL 16      (backend only)
                                        └─ redis     Redis 7 (BullMQ)   (backend only)
 Nightly cron: pg_dump ─▶ gzip ─▶ Cloudflare R2 (bucket "firstframe-backups")
 GitHub Actions: test ─▶ build amd64+arm64 images ─▶ ghcr.io ─▶ SSH ─▶ VM pulls + restarts
```

The `backend` Docker network is `internal`: the database, Redis and the verifier have **no published ports and no internet access**. Only Caddy listens on the public internet.

Files involved:

| File | Where it ends up |
|---|---|
| `infra/docker-compose.prod.yml` | `/opt/firstframe/docker-compose.yml` on the VM |
| `infra/Caddyfile` | `/opt/firstframe/Caddyfile` |
| `infra/.env.prod.example` | template for `/opt/firstframe/.env` (secrets, never in Git) |
| `scripts/*.sh` | `/opt/firstframe/scripts/` (deploy, backup, restore, server setup) |
| `.github/workflows/ci.yml`, `deploy.yml` | GitHub Actions |

### The free limits you are working within

| Service | Free limit | Source |
|---|---|---|
| Oracle Always Free, Ampere A1 | **2 OCPU + 12 GB RAM** in total (1,500 OCPU-hours and 9,000 GB-hours a month), only in your **home region** | [Oracle: Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/resourceref.htm) (halved from 4 OCPU/24 GB in 2026, see [Linuxiac](https://linuxiac.com/?p=214114)) |
| Oracle block storage | **200 GB** boot + block volumes in total, plus 5 volume backups | same page |
| Oracle outbound traffic | **10 TB / month** | same page |
| Oracle idle reclaim | An Always Free VM can be reclaimed if, over 7 days, 95th-percentile CPU **and** network **and** memory (A1 only) are all under 20% | same page |
| Cloudflare R2 | **10 GB-month** storage, **1 million** Class A (write/list) and **10 million** Class B (read) operations a month, **free egress** | [R2 pricing](https://developers.cloudflare.com/r2/pricing/) |
| Cloudflare proxy | Request bodies **up to 100 MB** on Free and Pro plans | [Cloudflare error 413](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/) |
| GitHub Actions | Unlimited minutes on standard runners for **public** repos; **2,000 min/month** for private repos on GitHub Free | [GitHub plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans) |
| GitHub arm64 runners (`ubuntu-24.04-arm`) | Free for public repos ([changelog](https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/)); available to private repos since January 2026 but billed against your minutes | [Classmethod summary](https://dev.classmethod.jp/articles/github-actions-arm64-private-repos/) |
| GitHub Container Registry | Container image storage and bandwidth are **currently free** (GitHub promises one month's notice before charging) | [GitHub Packages billing](https://docs.github.com/en/billing/concepts/product-billing/github-packages) |

Two decisions follow from these limits:

1. **The API domain is "DNS only" in Cloudflare (grey cloud).** Videos can be up to 500 MB, but Cloudflare's free proxy rejects bodies over 100 MB. Cloudflare's free-plan terms also restrict serving mostly video (see `docs/RESEARCH.md`). The web domain can be proxied (orange cloud).
2. **Uploads are stored on the VM's disk (`STORAGE_DRIVER=local`).** The API's `s3` driver sends *everything* to R2, originals included, and R2 is only free up to 10 GB. The VM has about 150 GB free for media. R2 is used only for backups.

**The only unavoidable cost is a domain** (about ₹100–170 for the first year of a `.in`; renewals cost more). With no domain at all, use the free DuckDNS option in step 4B.

---

## 1. Create the Oracle Cloud VM

### 1.1 Sign up

1. Go to <https://signup.cloud.oracle.com>. You need a credit/debit card for identity checks (a small hold is refunded).
2. **Home region:** choose carefully, it can **never** be changed, and Always Free VMs only run there. From India, pick **India West (Mumbai)** or **India South (Hyderabad)**.
3. New accounts get a 30-day trial with US$300 of credit. Always Free resources keep working after the trial ends.

### 1.2 Make an SSH key on your laptop

```bash
ssh-keygen -t ed25519 -f ~/.ssh/firstframe_vm -C "firstframe-vm"
cat ~/.ssh/firstframe_vm.pub      # you'll paste this into Oracle
```

(Windows: run this in PowerShell; OpenSSH is built in. Paths become `$HOME\.ssh\...`.)

### 1.3 Create the instance

Console menu ☰ → **Compute → Instances → Create instance**:

| Setting | Value |
|---|---|
| Name | `firstframe` |
| Image | **Canonical Ubuntu 24.04** (the aarch64 build is chosen automatically for Ampere) |
| Shape | **Ampere → VM.Standard.A1.Flex**, **2 OCPUs, 12 GB memory** |
| Networking | Create a new VCN and public subnet; **Assign a public IPv4 address: yes** |
| SSH keys | **Paste public key** → contents of `firstframe_vm.pub` |
| Boot volume | **Specify a custom size: 200 GB** (the whole free allowance; one VM uses it all) |

Click **Create**. When it is **Running**, copy the **Public IP address**: that is `<VM_IP>`. It stays the same across reboots and stop/start; it changes only if you terminate the instance.

### 1.4 "Out of capacity" errors

Free Ampere capacity is often sold out. What helps, in order:

1. Try **each availability domain** (AD-1/2/3 in the *Placement* section; Mumbai and Hyderabad have one AD each, so retry later instead).
2. Retry at off-peak hours (early morning IST). Capacity frees up when others delete VMs. Errors can last days.
3. Create a smaller VM (1 OCPU / 6 GB) now, then **Stop → Edit shape** to 2 OCPU / 12 GB later.
4. Upgrade the account to **Pay As You Go** (Billing → Upgrade). Always Free resources stay free, and many users report far fewer capacity errors. **Then set a budget alert** (Billing → Budgets → Create budget, amount ₹1, alert at 1%) so any accidental paid resource emails you at once.

### 1.5 Open ports 80 and 443 in Oracle's firewall (Security List)

Oracle has two firewalls. This is the cloud one; step 2 handles the one inside Ubuntu.

☰ → **Networking → Virtual cloud networks** → your VCN → **Security** (or *Security Lists*) → **Default Security List** → **Add Ingress Rules**, three times:

| Source CIDR | IP protocol | Destination port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |
| `0.0.0.0/0` | UDP | `443` (HTTP/3, optional) |

Port 22 (SSH) is already open.

---

## 2. Set up the server

```bash
ssh -i ~/.ssh/firstframe_vm ubuntu@<VM_IP>
```

From your laptop, copy the setup script up (from a clone of your repo), then run it on the VM:

```bash
# laptop
scp -i ~/.ssh/firstframe_vm scripts/server-setup.sh ubuntu@<VM_IP>:~
# VM
sudo bash ~/server-setup.sh
exit          # log out and back in so `ubuntu` can use docker without sudo
```

`scripts/server-setup.sh` installs Docker Engine + the Compose plugin from Docker's official repository, `rclone` and `cron`; opens 80/443 in **iptables**; adds 2 GB of swap; creates `/opt/firstframe`; turns on automatic security updates; and installs the nightly backup cron job. It is safe to run again.

**Why iptables?** Oracle's Ubuntu image ships with iptables rules that **REJECT everything except SSH**, even after you open the Security List. Rules are checked top to bottom, so ACCEPT rules must sit *above* the final REJECT. The script inserts them there and also adds them to `/etc/iptables/rules.v4` so they survive reboots. Check:

```bash
docker run --rm hello-world
sudo iptables -L INPUT -n --line-numbers   # 80 and 443 ACCEPT lines must come before REJECT
```

Doing it by hand instead (what the script does):

```bash
sudo iptables -I INPUT 5 -p tcp -m state --state NEW -m tcp --dport 80 -j ACCEPT    # 5 = line of the REJECT rule
sudo iptables -I INPUT 5 -p tcp -m state --state NEW -m tcp --dport 443 -j ACCEPT
sudo nano /etc/iptables/rules.v4   # add the same two "-A INPUT ... -j ACCEPT" lines above "-A INPUT -j REJECT ..."
```

---

## 3. Domain and DNS

### 3A. With your own domain, through Cloudflare (recommended)

1. Buy a domain from any registrar (a `.in` costs about ₹100–170 for the first year).
2. Create a free account at <https://dash.cloudflare.com> → **Add a domain** → choose the **Free** plan.
3. Cloudflare shows two nameservers. At your registrar, replace the nameservers with those two. Wait until Cloudflare says the domain is **Active** (minutes to a few hours).
4. **DNS → Records → Add record**:

   | Type | Name | IPv4 address | Proxy status |
   |---|---|---|---|
   | A | `@` (that is, `<WEB_DOMAIN>`) | `<VM_IP>` | **DNS only** (grey) for now |
   | A | `api` | `<VM_IP>` | **DNS only** (grey), **always** |

5. **SSL/TLS → Overview → Full (strict)**. Never use "Flexible": it sends traffic from Cloudflare to your server unencrypted and causes redirect loops with Caddy.

After the first deploy works (step 7), you may switch the `@` record to **Proxied** (orange) to get Cloudflare's CDN for the web app. Keep `api` grey (100 MB upload limit and video terms, see section 0).

Check DNS from your laptop: `nslookup <API_DOMAIN>` must print `<VM_IP>`.

### 3B. No domain: free DuckDNS subdomain

1. Sign in at <https://www.duckdns.org> (GitHub/Google login). Create a subdomain, e.g. `firstframe-asha`, and set its **current ip** to `<VM_IP>`.
2. Use:
   - `WEB_DOMAIN=firstframe-asha.duckdns.org`
   - `API_DOMAIN=api.firstframe-asha.duckdns.org` (DuckDNS answers for names under your subdomain with the same IP; confirm with `nslookup api.firstframe-asha.duckdns.org`).
3. Skip Cloudflare. Caddy still gets real Let's Encrypt certificates.

Keep both names under the **same** parent (`x.duckdns.org` and `api.x.duckdns.org`). The login cookie is `SameSite=Lax`, so the web app and the API must be on the same *site*. Two unrelated DuckDNS names would be different sites, and login refresh would break.

---

## 4. Cloudflare R2 bucket for backups

1. Cloudflare dashboard → **R2 Object Storage**. Cloudflare may ask you to add a payment method to enable R2; staying inside the free tier costs nothing.
2. **Create bucket** → name `firstframe-backups`, location *Automatic*.
3. *(Safety net)* Bucket → **Settings → Object lifecycle rules → Add rule**: prefix `postgres/`, *Delete objects* after **30 days**. The backup script already prunes after 14 days; this catches anything it misses.
4. R2 overview → **Account Details → API Tokens → Manage → Create Account API token**:
   - Permissions: **Object Read & Write**
   - Specify bucket: **only `firstframe-backups`**
   - Create, then copy the **Access Key ID** and **Secret Access Key** (the secret is shown only once) and the **S3 endpoint** `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.

A nightly dump of a small database is a few MB, so 14 days of backups use a tiny part of the 10 GB.

---

## 5. Production settings (`/opt/firstframe/.env`)

On the VM:

```bash
cd /opt/firstframe
# Get the template (or scp infra/.env.prod.example from your laptop):
curl -fsSL -o .env https://raw.githubusercontent.com/<GH_USER>/<REPO>/main/infra/.env.prod.example
chmod 600 .env
```

Generate secrets **on the VM** and paste each into `.env` (`nano .env`):

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)"
echo "JWT_ACCESS_SECRET=$(openssl rand -base64 48)"
echo "SIGNING_SECRET=$(openssl rand -base64 48)"
echo "INTERNAL_TOKEN=$(openssl rand -hex 32)"
echo "ADMIN_PASSWORD=$(openssl rand -base64 18)"
```

Fill in the rest:

| Variable | Value |
|---|---|
| `WEB_DOMAIN`, `API_DOMAIN` | from step 3 |
| `ACME_EMAIL` | your email (Let's Encrypt expiry notices) |
| `IMAGE_PREFIX` | `ghcr.io/<gh_user_in_lowercase>` |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay **test** keys (step 9) |
| `RAZORPAY_WEBHOOK_SECRET` | any long random string; you'll type the same one into Razorpay |
| `ADMIN_EMAIL` | your email |
| `BACKUP_S3_*` | from step 4 |

Rules: `POSTGRES_PASSWORD` must be hex (it goes inside a URL). Each secret must be different and at least 32 characters; the API refuses to start in production otherwise. `PAYMENTS_PROVIDER=mock` is refused in production.

Check that it parses (once `docker-compose.yml` is there after the first workflow run, or scp it now):

```bash
cd /opt/firstframe && docker compose config --quiet && echo OK
```

---

## 6. GitHub: CI, images and deploy secrets

### 6.1 Push the code

Push the repo to GitHub. **Public repos get free arm64 runners and unlimited Actions minutes.** For a private repo the build still works but uses your 2,000 free minutes. The verifier image with PyTorch is the slow one.

### 6.2 A deploy key just for GitHub Actions

On your laptop:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/firstframe_deploy -N "" -C "github-actions-deploy"
ssh-copy-id -i ~/.ssh/firstframe_deploy.pub -o "IdentityFile ~/.ssh/firstframe_vm" ubuntu@<VM_IP>
ssh-keyscan -H <VM_IP>          # copy the output: this is SSH_KNOWN_HOSTS
```

(Check the printed fingerprint matches what `ssh -i ~/.ssh/firstframe_vm ubuntu@<VM_IP>` showed the first time.)

### 6.3 Repository settings

**Settings → Environments → New environment → `production`**. Optional: add yourself as a *required reviewer* so each deploy waits for your click.

**Environment secrets** (in `production`):

| Secret | Value |
|---|---|
| `SSH_HOST` | `<VM_IP>` |
| `SSH_USER` | `ubuntu` |
| `SSH_PRIVATE_KEY` | full contents of `~/.ssh/firstframe_deploy` (the private key, including the BEGIN/END lines) |
| `SSH_KNOWN_HOSTS` | output of `ssh-keyscan -H <VM_IP>` |
| `SSH_PORT` | optional, default 22 |

**Settings → Secrets and variables → Actions → Variables** (repository variables, not secret):

| Variable | Value |
|---|---|
| `PUBLIC_API_URL` | `https://<API_DOMAIN>` (optional: the deploy job checks `/api/v1/health` there afterwards) |
| `WEB_DOMAIN` | `<WEB_DOMAIN>` (only used for the link on the deployment) |
| `DEPLOY_ENABLED` | `false` for now |

The workflows need no personal access token: they use the short-lived `GITHUB_TOKEN`, with `packages: write` only in the jobs that push images.

### 6.4 What the workflows do

- **`ci.yml`** (pull requests, and pushes to branches other than `main`):
  - **api:** lint, typecheck, unit tests, then e2e tests against Postgres 16 and Redis 7 service containers.
  - **web:** lint, typecheck, unit tests, `next build`.
  - **verifier:** `ruff check`, `ruff format --check`, `pytest`.
  - **infra:** validates both compose files and the Caddyfile, and runs `shellcheck`.
  - **docker:** builds all three images and smoke-tests the API image (ffmpeg `drawtext`, fonts, `dist/worker.js`, migrations).
- **`deploy.yml`** (push to `main`, or run by hand):
  1. Runs all of CI.
  2. Builds each image natively on an amd64 runner and an arm64 runner.
  3. Pushes them to `ghcr.io/<owner>/firstframe-{api,web,verifier}`, tagged with the commit SHA and `latest`.
  4. If `DEPLOY_ENABLED` is `true`: copies the compose file, Caddyfile and scripts to the VM over SSH. Then it runs `scripts/deploy.sh <sha>` there (pull → migrate → `up -d` → wait for the API health check) and finally checks `https://<API_DOMAIN>/api/v1/health` from outside.

The same web image works for any domain: the browser learns the API address at runtime from `/runtime-config.js`, which the web container fills from `API_DOMAIN`.

---

## 7. First deploy

1. Push to `main` (or **Actions → Deploy → Run workflow**). With `DEPLOY_ENABLED=false`, it only builds and pushes images. Check that **Actions** is green and that **your profile → Packages** shows three `firstframe-*` packages.
2. **Private packages:** the deploy job logs the VM in to ghcr.io with its own token, so nothing extra is needed. To pull by hand on the VM, make the packages public (package → *Package settings → Change visibility*) or `docker login ghcr.io` with a personal token that has only `read:packages`.
3. Make sure `/opt/firstframe/.env` is complete (step 5) and DNS points at the VM (step 3).
4. Set `DEPLOY_ENABLED` = `true`, then **Actions → Deploy → Run workflow** on `main`.
5. Watch it on the VM:

   ```bash
   cd /opt/firstframe
   docker compose ps                     # api should be "healthy"
   docker compose logs -f caddy          # look for "certificate obtained successfully"
   curl -s https://<API_DOMAIN>/api/v1/health
   ```

6. Open `https://<WEB_DOMAIN>`.

### Create the admin account (once)

```bash
cd /opt/firstframe
docker compose run --rm seed            # uses ADMIN_EMAIL / ADMIN_PASSWORD from .env
sed -i 's/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=/' .env    # don't leave it lying around
```

Log in at `https://<WEB_DOMAIN>/login` and change nothing else in `.env` for now.

### Turn on the Cloudflare proxy for the web app (optional)

Now that Caddy has a certificate, in Cloudflare set the `@` record to **Proxied** with SSL mode **Full (strict)**. Certificate renewals still work over HTTP-01, which Cloudflare passes through to Caddy on port 80. Leave Cloudflare's **SSL/TLS → Edge Certificates → Always Use HTTPS** off: Caddy already redirects HTTP to HTTPS, and this keeps renewal requests simple. Keep `api` DNS-only. If a renewal ever fails while proxied, set the record back to grey for a few minutes and run `docker compose restart caddy`.

### Deploy by hand (without GitHub Actions)

```bash
cd /opt/firstframe
# put docker-compose.yml, Caddyfile and scripts/ in place (scp from infra/ and scripts/)
scripts/deploy.sh latest
```

---

## 8. Payments: Razorpay test mode, then live

### Test mode (start here)

1. Sign up at <https://dashboard.razorpay.com>. Make sure the dashboard toggle says **Test Mode**.
2. **Account & Settings → API Keys → Generate Key**. Put the `rzp_test_...` Key ID and the secret into `.env`.
3. **Account & Settings → Webhooks → Add New Webhook**:
   - URL: `https://<API_DOMAIN>/api/v1/payments/razorpay/webhook`
   - Secret: the same value as `RAZORPAY_WEBHOOK_SECRET` in `.env`
   - Events: `order.paid` and `payment.captured`
4. Apply: `cd /opt/firstframe && docker compose up -d` (Compose recreates `api` and `worker` because their environment changed).
5. Buy a licence as an approved channel using Razorpay's test card/UPI details from their docs. Check that the order becomes PAID and the uploader's earnings increase.

### Going live

1. Complete Razorpay **KYC / account activation** (PAN, bank account; Razorpay says it takes 24–48 hours). Read the payments notes in `docs/RESEARCH.md` first. Ask Razorpay in writing whether "collect, then pay uploaders out" is allowed for your account, and talk to a CA.
2. Switch the dashboard to **Live Mode** → **API Keys → Generate Key** (`rzp_live_...`). Test and live keys are separate, and the secret is shown only once.
3. Webhooks are configured per mode: add the **same webhook again in Live Mode**, with a **new** secret.
4. Update `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` in `.env`, then run `docker compose up -d`.
5. Make one small real purchase and refund it from the dashboard.

---

## 9. Backups and restore

### What is backed up

| Data | Backed up by | Where |
|---|---|---|
| PostgreSQL (users, orders, ledger, metadata) | `scripts/backup-db.sh`, nightly at 02:30 | `/var/backups/firstframe` on the VM **and** R2 `firstframe-backups/postgres/`, kept 14 days |
| Uploaded media (`mediadata` volume) | **not** by the script (too big for R2's free 10 GB) | see below |
| TLS certificates (`caddy_data`) | not needed: Caddy re-issues them | n/a |
| Redis (job queue) | not needed: jobs are re-created by the processing scheduler | n/a |

Check that the backup works the first time:

```bash
/opt/firstframe/scripts/backup-db.sh          # dump, upload, prune
tail -n 20 /var/log/firstframe-backup.log      # the cron job writes here
crontab -l                                     # shows the 02:30 job
/opt/firstframe/scripts/restore-db.sh --list   # what's in R2 and on disk
```

**Media:** take a manual **boot volume backup** about once a month in Oracle (Compute → Instance → Boot volume → *Boot volume backups → Create*; 5 backups are free). Better still, once you have budget, set `STORAGE_DRIVER=s3` and let R2 hold the files.

### Restore

```bash
cd /opt/firstframe
scripts/restore-db.sh latest          # newest dump from R2; asks you to type RESTORE
# or a specific one:
scripts/restore-db.sh firstframe-20261011T023000Z.sql.gz
# or a local file:
scripts/restore-db.sh /var/backups/firstframe/firstframe-20261011T023000Z.sql.gz
```

It saves a safety dump of the current database first, stops `api` and `worker`, recreates the database, loads the dump in a single transaction, runs migrations and starts everything again.

**Practise a restore once a month.** A backup you have never restored is only a hope.

### Moving to a new VM

Run steps 1–6 on the new VM, copy `.env`, deploy, then `scripts/restore-db.sh latest`. Copy media with `docker run --rm -v firstframe_mediadata:/data alpine tar -C /data -cz . | ssh newvm 'docker run --rm -i -v firstframe_mediadata:/data alpine tar -C /data -xz'`. Finally, point DNS at the new IP.

---

## 10. Updating

| Task | How |
|---|---|
| Ship new code | Merge to `main`. CI runs, images are built, and the VM updates itself |
| Roll back | **Actions → Deploy → Run workflow**, `ref_tag` = an older commit SHA (its images are still in ghcr.io), or on the VM: `scripts/deploy.sh <old-sha>` |
| Change a setting | Edit `/opt/firstframe/.env`, then `docker compose up -d` |
| Update Postgres/Redis/Caddy patch versions | `docker compose pull && docker compose up -d` (tags `16-alpine`, `7-alpine`, `2-alpine` follow patch releases) |
| Ubuntu security updates | automatic (unattended-upgrades). Reboot now and then: `sudo reboot`; containers restart by themselves (`restart: unless-stopped`) |
| Postgres **major** upgrade (16 → 17) | not in place: back up, change the image, start with an empty volume, restore |

**Downtime:** `deploy.sh` recreates only the containers whose image changed. The API is unavailable for a few seconds while its new container starts, and Socket.IO clients reconnect by themselves. Migrations run *before* the new code starts, so they must be backward compatible (add columns first; remove old ones in a later release).

---

## 11. Troubleshooting

| Symptom | Likely cause → fix |
|---|---|
| Browser can't connect at all (timeout) | Port blocked. Check **both** the Oracle Security List (step 1.5) **and** `sudo iptables -L INPUT -n --line-numbers` (ACCEPT must be above REJECT). Test from your laptop: `curl -v http://<VM_IP>` |
| Caddy logs `challenge failed` / `no valid A records` | DNS doesn't point at `<VM_IP>` yet, port 80 is blocked, or the record is orange-cloud before the first certificate. Make it grey, wait, `docker compose restart caddy` |
| `too many certificates` (rate limit) | You recreated `caddy_data` too often. Wait (limits reset weekly) and, while testing, uncomment the `acme_ca` staging line in the Caddyfile |
| Redirect loop on the web domain | Cloudflare SSL mode is "Flexible". Set **Full (strict)** |
| Uploads > 100 MB fail with 413 | `api` record is orange-cloud. Make it **DNS only** |
| `api` restarting, logs say `... is required in production` / `must be at least 32 characters` | A secret in `.env` is missing or short. Regenerate it (step 5) and `docker compose up -d` |
| `migrate` exits with an error | `docker compose logs migrate`. Usually a wrong `POSTGRES_PASSWORD` after the volume was first created; the password is fixed at first start. Fix `.env` to the original, or (only if empty) `docker compose down && docker volume rm firstframe_pgdata` |
| Deploy job: `Permission denied (publickey)` | `SSH_PRIVATE_KEY` is not the private half of the key in `~/.ssh/authorized_keys` on the VM, or `SSH_USER` is wrong |
| Deploy job: `Host key verification failed` | `SSH_KNOWN_HOSTS` is stale (VM recreated). Re-run `ssh-keyscan -H <VM_IP>` |
| `docker compose pull`: `denied` / `unauthorized` | Packages are private and you're pulling by hand. Make them public or `docker login ghcr.io` |
| `exec format error` | An image was built for the wrong CPU. The deploy workflow builds both; never push a laptop-built amd64-only image to the arm VM |
| Web app calls `localhost:4000` | The web container gets `PUBLIC_API_URL=https://${API_DOMAIN}` from the compose file. Check `API_DOMAIN` in `.env`, then `docker compose up -d web` and `curl https://<WEB_DOMAIN>/runtime-config.js` |
| Login works but you're logged out after 15 min | The refresh cookie isn't reaching the API: web and API must share a site (`x.com` + `api.x.com`) and both be HTTPS |
| Uploads stay "processing" | `docker compose logs worker verifier`. Check the verifier is up and `INTERNAL_TOKEN` is the same for both (it's one variable in `.env`) |
| Out of memory / containers killed | `docker stats`. Set `AI_MODEL_ENABLED=false` (saves ~1 GB) or lower limits in `docker-compose.yml` |
| Disk filling up | `df -h`, `docker system df`. Prune: `docker image prune -a --filter until=168h`. Media lives in the `firstframe_mediadata` volume |
| Oracle emailed about an idle instance | Usage under 20% for 7 days. A loaded AI model normally keeps memory above that. Check `free -h`; a small cron job doing real work also helps |
| Backup: `rclone: command not found` | `sudo apt-get install -y rclone` (or re-run `server-setup.sh`) |
| Backup: `403 AccessDenied` from R2 | The token isn't scoped to `firstframe-backups`, lacks *Object Read & Write*, or the endpoint has the wrong account ID |

Useful commands:

```bash
cd /opt/firstframe
docker compose ps
docker compose logs --tail 100 -f api worker
docker compose exec postgres psql -U firstframe firstframe     # SQL shell (no public port)
docker stats --no-stream
```

---

## 12. When you outgrow the free tier

Watch for:
- The processing queue backing up (2 cores run one ffmpeg job at a time).
- Disk above 80% (`df -h`).
- Memory pressure (`docker stats`).
- More than about 10 GB of backups or previews you'd like in R2.

| Problem | Cheapest next step |
|---|---|
| Media disk full | `STORAGE_DRIVER=s3` with R2: $0.015/GB-month beyond 10 GB, egress free (about ₹125 a month per 100 GB) |
| CPU-bound processing | A second small VM running only `worker` (it needs Postgres, Redis and storage reachable: switch to `STORAGE_DRIVER=s3` first) |
| Oracle reclaims the VM or capacity disappears | Move to a cheap paid VPS (below) with the "Moving to a new VM" steps; Docker Compose makes this an afternoon's work |

**Paid VPS fallback.** Typical August 2026 prices before VAT ([comparison](https://kimmo.suominen.com/stuff/cpc-2026-08.txt)):

| Plan | Spec | Price |
|---|---|---|
| Netcup VPS 500 G12 (x86) | 2 vCPU / 4 GB | €4.97/month (about ₹500) |
| Hetzner CX23 (x86) | 2 vCPU / 4 GB | €5.99/month |
| Hetzner CAX11 (Arm) | 2 vCPU / 4 GB | €6.49/month |

At roughly ₹100 per euro, that is **about ₹500–650 a month**; check today's rate. These have **4 GB**, a third of Oracle's free 12 GB, so run them with `AI_MODEL_ENABLED=false` (or pay for 8 GB), and lower the memory limits in `docker-compose.yml`. The images are multi-arch, so the same deploy works on x86 and Arm.

Beyond one server, see "How this would scale" in `docs/learning/deployment.md`.

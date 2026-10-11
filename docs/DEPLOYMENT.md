# Deploying Micky for ₹0 a month

This guide takes you from nothing to a live Micky on the internet, with HTTPS, automatic deploys from GitHub and nightly backups. Every command is meant to be copied and pasted. Replace the placeholders in `<ANGLE_BRACKETS>`.

| Placeholder | Example | Meaning |
|---|---|---|
| `<VM_IP>` | `140.238.10.20` | Your Oracle VM's public IP |
| `<WEB_DOMAIN>` | `micky.in` | Address of the web app |
| `<API_DOMAIN>` | `api.micky.in` | Address of the API |
| `<GH_USER>/<REPO>` | `asha/micky` | Your GitHub repository |

> Limits below were checked on **11 October 2026**. Free tiers change: re-check the linked pages before you rely on a number.

---

## 0. What runs where

```
 Browser ──HTTPS──▶ Cloudflare DNS ──▶ Oracle VM (Ubuntu, arm64, Docker Compose)
                                        ├─ caddy     :80/:443  TLS certificates + reverse proxy
                                        ├─ web       Next.js            (edge network)
                                        ├─ api       NestJS             (edge + backend)
                                        ├─ worker    NestJS + ffmpeg    (backend only: no internet)
                                        ├─ verifier  FastAPI + PyTorch  (backend only)
                                        ├─ postgres  PostgreSQL 16      (backend only)
                                        └─ redis     Redis 7 (BullMQ)   (backend only)
 Nightly cron: pg_dump ─▶ gzip ─▶ age (encrypt to YOUR public key) ─▶ Cloudflare R2 "micky-backups/postgres/"
               sold originals ─▶ age ─▶ R2 "micky-backups/media/"
 GitHub Actions: test ─▶ build amd64+arm64 images ─▶ ghcr.io ─▶ SSH (forced command: deploy gate) ─▶ VM pulls + restarts
```

The `backend` Docker network is `internal`: the database, Redis, the verifier and the worker (which parses untrusted video) have **no published ports and no internet access**. Only Caddy listens on the public internet. Each container receives only the secrets it needs (see step 5).

Files involved:

| File | Where it ends up |
|---|---|
| `infra/docker-compose.prod.yml` | `/opt/micky/docker-compose.yml` on the VM |
| `infra/Caddyfile` | `/opt/micky/Caddyfile` |
| `infra/.env.prod.example` | template for `/opt/micky/.env` (secrets, never in Git) |
| `scripts/*.sh` | `/opt/micky/scripts/` (deploy, backup, restore, server setup); copied by **you**, not by CI |
| `scripts/deploy-gate.sh` | `/usr/local/sbin/micky-deploy-gate` (root-owned; installed by `server-setup.sh`) |
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

1. **The API domain is "DNS only" in Cloudflare (grey cloud).** Videos can be up to 500 MB, but Cloudflare's free proxy rejects bodies over 100 MB. Cloudflare's free-plan terms also restrict serving mostly video (see `docs/RESEARCH.md`). It also keeps rate limits correct: the API trusts exactly one proxy (Caddy, `TRUST_PROXY_HOPS=1`), and behind an orange cloud every client would share Cloudflare's IP addresses. The web domain can be proxied (orange cloud).
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
ssh-keygen -t ed25519 -f ~/.ssh/micky_vm -C "micky-vm"
cat ~/.ssh/micky_vm.pub      # you'll paste this into Oracle
```

(Windows: run this in PowerShell; OpenSSH is built in. Paths become `$HOME\.ssh\...`.)

### 1.3 Create the instance

Console menu ☰ → **Compute → Instances → Create instance**:

| Setting | Value |
|---|---|
| Name | `micky` |
| Image | **Canonical Ubuntu 24.04** (the aarch64 build is chosen automatically for Ampere) |
| Shape | **Ampere → VM.Standard.A1.Flex**, **2 OCPUs, 12 GB memory** |
| Networking | Create a new VCN and public subnet; **Assign a public IPv4 address: yes** |
| SSH keys | **Paste public key** → contents of `micky_vm.pub` |
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
ssh -i ~/.ssh/micky_vm ubuntu@<VM_IP>
```

From your laptop, copy the scripts up (from a clone of your repo), then run the setup script on the VM:

```bash
# laptop
scp -i ~/.ssh/micky_vm -r scripts ubuntu@<VM_IP>:~/ff-scripts
# VM
sudo bash ~/ff-scripts/server-setup.sh
mkdir -p /opt/micky/scripts && cp ~/ff-scripts/*.sh /opt/micky/scripts/ && chmod +x /opt/micky/scripts/*.sh
exit          # log out and back in so `ubuntu` can use docker without sudo
```

`scripts/server-setup.sh`:
- installs Docker Engine and the Compose plugin from Docker's official repository, plus `rclone`, `age`, `python3` and `cron`;
- opens 80/443 in **iptables**;
- adds 2 GB of swap;
- creates `/opt/micky`;
- turns on automatic security updates;
- installs the nightly backup cron jobs (database 02:30, sold originals 03:15);
- installs the deploy gate as `/usr/local/sbin/micky-deploy-gate` (step 6.2).

It is safe to run again.

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

1. Sign in at <https://www.duckdns.org> (GitHub/Google login). Create a subdomain, e.g. `micky-asha`, and set its **current ip** to `<VM_IP>`.
2. Use:
   - `WEB_DOMAIN=micky-asha.duckdns.org`
   - `API_DOMAIN=api.micky-asha.duckdns.org` (DuckDNS answers for names under your subdomain with the same IP; confirm with `nslookup api.micky-asha.duckdns.org`).
3. Skip Cloudflare. Caddy still gets real Let's Encrypt certificates.

Keep both names under the **same** parent (`x.duckdns.org` and `api.x.duckdns.org`). The login cookie is `SameSite=Lax`, so the web app and the API must be on the same *site*. Two unrelated DuckDNS names would be different sites, and login refresh would break.

---

## 4. Backup key and Cloudflare R2 bucket

### 4.1 The backup encryption key (on your laptop, never on the server)

Backups contain every user's email, password hash, UPI ID and GPS metadata. They are encrypted **on the server** with [age](https://age-encryption.org) to a **public** key. Only the matching private key can decrypt them, and it never goes on the server. A leaked R2 token or a hacked VM therefore cannot read a single backup.

```bash
# laptop (macOS: brew install age · Ubuntu: sudo apt install age · Windows: winget install FiloSottile.age)
age-keygen -o micky-backup-key.txt
# prints: Public key: age1...   <- this goes into the server's .env (step 5)
```

Store `micky-backup-key.txt` in your password manager **and** a second place (an encrypted USB stick, or a printout in a drawer). **If you lose it, every backup is useless.** You only copy it to the server for the few minutes a restore takes.

### 4.2 R2 bucket

1. Cloudflare dashboard → **R2 Object Storage**. Cloudflare may ask you to add a payment method to enable R2; staying inside the free tier costs nothing.
2. **Create bucket** → name `micky-backups`, location *Automatic*.
3. Bucket → **Settings → Bucket lock rules → Add rule**: prefix `postgres/`, retain for **30 days**. Nobody can delete or overwrite a dump during that time, not even someone holding the server's R2 token. The backup script never deletes anything in R2.
4. Bucket → **Settings → Object lifecycle rules → Add rule**: prefix `postgres/`, *Delete objects* after **31 days**. This keeps storage flat. Do **not** add a delete rule for `media/`: sold originals are kept.
4. R2 overview → **Account Details → API Tokens → Manage → Create Account API token**:
   - Permissions: **Object Read & Write**
   - Specify bucket: **only `micky-backups`**
   - Create, then copy the **Access Key ID** and **Secret Access Key** (the secret is shown only once) and the **S3 endpoint** `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.

A nightly dump of a small database is a few MB, so 30 days of dumps use a tiny part of the 10 GB. The rest is for sold originals; `backup-media.sh` stops before the bucket passes `BACKUP_MEDIA_MAX_GB` (default 8 GB, leaving headroom).

---

## 5. Production settings (`/opt/micky/.env`)

On the VM:

```bash
cd /opt/micky
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
| `ADMIN_EMAIL` | your email (a normal address: the seed refuses one the login form would reject) |
| `BACKUP_AGE_RECIPIENTS` | the `age1...` **public** key from step 4.1 |
| `BACKUP_S3_*` | from step 4.2 |

Rules: `POSTGRES_PASSWORD` must be hex (it goes inside a URL). Each secret must be different and at least 32 characters; the API refuses to start in production otherwise. `PAYMENTS_PROVIDER=mock` is refused in production.

**Who sees which secret.** `.env` is not handed to the containers as a whole. `docker-compose.yml` passes each service only what it needs:

| Container | Secrets it receives |
|---|---|
| `api` | `JWT_ACCESS_SECRET`, `SIGNING_SECRET`, `RAZORPAY_*`, `DATABASE_URL` |
| `worker` | `INTERNAL_TOKEN`, `DATABASE_URL` |
| `verifier` | `INTERNAL_TOKEN` |
| `migrate` | `DATABASE_URL` |
| `seed` (run by hand) | `DATABASE_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` |
| *(host cron only)* | `BACKUP_*` |

If you add a setting to `.env`, also add it to the right service in `docker-compose.yml`, or the app will not see it.

Check that it parses (once `docker-compose.yml` is there after the first workflow run, or scp it now):

```bash
cd /opt/micky && docker compose config --quiet && echo OK
```

---

## 6. GitHub: CI, images and deploy secrets

### 6.1 Push the code

Push the repo to GitHub. **Public repos get free arm64 runners and unlimited Actions minutes.** For a private repo the build still works but uses your 2,000 free minutes. The verifier image with PyTorch is the slow one.

### 6.2 A deploy key just for GitHub Actions

On your laptop:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/micky_deploy -N "" -C "github-actions-deploy"
# Allow this key to run ONLY the deploy gate (no shell, no forwarding):
pub="$(cat ~/.ssh/micky_deploy.pub)"
ssh -i ~/.ssh/micky_vm ubuntu@<VM_IP> \
  "echo 'command=\"/usr/local/sbin/micky-deploy-gate\",restrict $pub' >> ~/.ssh/authorized_keys"
ssh-keyscan -H <VM_IP>          # copy the output: this is SSH_KNOWN_HOSTS (required)
```

Check the printed fingerprint matches what `ssh -i ~/.ssh/micky_vm ubuntu@<VM_IP>` showed the first time. The deploy workflow refuses to run without `SSH_KNOWN_HOSTS`: trusting whatever host answers would let a man-in-the-middle receive your registry token.

**Why the forced command.** The `ubuntu` user is in the `docker` group, which is as powerful as root. Without the `command=` prefix, anyone who stole this key from GitHub would effectively own the VM. With it, the key can only:

- **upload a new `docker-compose.yml` and `Caddyfile`**, which the gate rejects if they use images other than ours and the pinned official ones, or ask for `privileged`, host namespaces, extra capabilities, or bind mounts other than `./Caddyfile`;
- **deploy an image tag** (`scripts/deploy.sh <tag>`).

Test it: `ssh -i ~/.ssh/micky_deploy ubuntu@<VM_IP> id` must answer `deploy-gate: refused`. Your own `micky_vm` key keeps full access.

### 6.3 Repository settings

**Settings → Environments → New environment → `production`**. Optional: add yourself as a *required reviewer* so each deploy waits for your click.

**Environment secrets** (in `production`):

| Secret | Value |
|---|---|
| `SSH_HOST` | `<VM_IP>` |
| `SSH_USER` | `ubuntu` |
| `SSH_PRIVATE_KEY` | full contents of `~/.ssh/micky_deploy` (the private key, including the BEGIN/END lines) |
| `SSH_KNOWN_HOSTS` | output of `ssh-keyscan -H <VM_IP>` (**required**) |
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
  - **infra:** validates both compose files and the Caddyfile, runs `shellcheck` and `actionlint`, and runs `scripts/test-backups.sh` (encrypt → upload → restore round trip against a Postgres service container).
  - **docker:** builds all three images and smoke-tests the API image (ffmpeg `drawtext`, fonts, `dist/worker.js`, migrations).
- **`deploy.yml`** (push to `main`, or run by hand):
  1. Runs all of CI.
  2. Builds each image natively on an amd64 runner and an arm64 runner.
  3. Pushes them to `ghcr.io/<owner>/micky-{api,web,verifier}`, tagged with the commit SHA and `latest`.
  4. If `DEPLOY_ENABLED` is `true`:
     - sends the compose file and Caddyfile to the deploy gate (`ff-upload`), which validates them;
     - asks the gate to deploy the commit (`ff-deploy <sha>`), which runs `scripts/deploy.sh <sha>`: pull → migrate → `up -d` → wait for the API health check;
     - finally checks `https://<API_DOMAIN>/api/v1/health` from outside.

  The workflow does **not** copy `scripts/` any more. When the scripts change, copy them yourself (section 10).

**Supply chain.** Every action in the workflows is pinned to a full commit SHA, with its version in a comment, so a moved tag upstream cannot change what runs with our tokens. `.github/dependabot.yml` opens weekly PRs for actions, npm, pip and base images; each one runs the full CI before you merge it.

The same web image works for any domain: the browser learns the API address at runtime from `/runtime-config.js`, which the web container fills from `API_DOMAIN`.

---

## 7. First deploy

1. Push to `main` (or **Actions → Deploy → Run workflow**). With `DEPLOY_ENABLED=false`, it only builds and pushes images. Check that **Actions** is green and that **your profile → Packages** shows three `micky-*` packages.
2. **Private packages:** the deploy job logs the VM in to ghcr.io with its own token, so nothing extra is needed. To pull by hand on the VM, make the packages public (package → *Package settings → Change visibility*) or `docker login ghcr.io` with a personal token that has only `read:packages`.
3. Make sure `/opt/micky/.env` is complete (step 5) and DNS points at the VM (step 3).
4. Set `DEPLOY_ENABLED` = `true`, then **Actions → Deploy → Run workflow** on `main`.
5. Watch it on the VM:

   ```bash
   cd /opt/micky
   docker compose ps                     # api should be "healthy"
   docker compose logs -f caddy          # look for "certificate obtained successfully"
   curl -s https://<API_DOMAIN>/api/v1/health
   ```

6. Open `https://<WEB_DOMAIN>`.

### Create the admin account (once)

```bash
cd /opt/micky
docker compose run --rm seed            # uses ADMIN_EMAIL / ADMIN_PASSWORD from .env
sed -i 's/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=/' .env    # don't leave it lying around
```

Log in at `https://<WEB_DOMAIN>/login` and change nothing else in `.env` for now.

### Turn on the Cloudflare proxy for the web app (optional)

Now that Caddy has a certificate, in Cloudflare set the `@` record to **Proxied** with SSL mode **Full (strict)**. Certificate renewals still work over HTTP-01, which Cloudflare passes through to Caddy on port 80. Leave Cloudflare's **SSL/TLS → Edge Certificates → Always Use HTTPS** off: Caddy already redirects HTTP to HTTPS, and this keeps renewal requests simple. Keep `api` DNS-only. If a renewal ever fails while proxied, set the record back to grey for a few minutes and run `docker compose restart caddy`.

### Deploy by hand (without GitHub Actions)

```bash
cd /opt/micky
# put docker-compose.yml, Caddyfile and scripts/ in place (scp from infra/ and scripts/, with your own key)
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
4. Apply: `cd /opt/micky && docker compose up -d` (Compose recreates `api` and `worker` because their environment changed).
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
| PostgreSQL (users, orders, ledger, metadata) | `scripts/backup-db.sh`, nightly at 02:30; **age-encrypted** | `/var/backups/micky` on the VM (14 days) **and** R2 `micky-backups/postgres/` (bucket-locked 30 days, deleted after 31) |
| **Sold** originals (media with a paid or disputed order) | `scripts/backup-media.sh`, nightly at 03:15; **age-encrypted**, only new files | R2 `micky-backups/media/`, kept |
| Other originals (not sold yet) | **only** Oracle's boot-volume backup, monthly, by hand (below) | Oracle |
| Previews | not needed: the worker rebuilds them from the originals | n/a |
| TLS certificates (`caddy_data`) | not needed: Caddy re-issues them | n/a |
| Redis (job queue) | not needed: jobs are re-created by the processing scheduler | n/a |

**What this costs and where it stops (free tier, honestly):**
- R2's free 10 GB covers 30 days of dumps plus a few GB of sold originals. `backup-media.sh` refuses to upload past `BACKUP_MEDIA_MAX_GB` (default 8) and says so in the log. When that happens, either raise it (R2 charges $0.015/GB-month above 10 GB, about ₹125 per 100 GB) or move all media to R2 (`STORAGE_DRIVER=s3`).
- Unsold originals are not off-site. If the VM's disk dies between two monthly Oracle backups, witnesses' unsold uploads from that period are gone. They are re-uploadable by the witness, while sold ones are not.
- `backup-media.sh --scope all` also copies approved, unsold originals, if they fit.

**Media too:** take a manual **boot volume backup** about once a month in Oracle (Compute → Instance → Boot volume → *Boot volume backups → Create*; 5 backups are free).

Check that the backups work the first time:

```bash
/opt/micky/scripts/backup-db.sh             # dump, encrypt, upload
/opt/micky/scripts/backup-media.sh --dry-run # what would go to R2
/opt/micky/scripts/backup-media.sh
tail -n 20 /var/log/micky-backup.log         # the cron jobs write here
crontab -l                                        # shows the 02:30 and 03:15 jobs
/opt/micky/scripts/restore-db.sh --list      # what's in R2 and on disk
```

### Restore

The private key from step 4.1 is needed. Copy it up only for the restore:

```bash
scp -i ~/.ssh/micky_vm micky-backup-key.txt ubuntu@<VM_IP>:~/backup-key.txt     # laptop
cd /opt/micky
scripts/restore-db.sh latest --identity ~/backup-key.txt         # newest dump in R2; asks you to type RESTORE
# or a specific one:
scripts/restore-db.sh micky-20261011T023000Z.sql.gz.age --identity ~/backup-key.txt
# or a local file:
scripts/restore-db.sh /var/backups/micky/micky-20261011T023000Z.sql.gz.age --identity ~/backup-key.txt
# after losing the disk: put the sold originals back (skips files that are already there)
scripts/restore-media.sh --identity ~/backup-key.txt
shred -u ~/backup-key.txt                                         # never leave it on the server
```

`restore-db.sh` works in this order:
1. It decrypts and checks the dump **before** touching anything. A wrong key or a damaged file stops it here.
2. It saves a safety dump of the current database.
3. It stops `api` and `worker` and recreates the database.
4. It loads the dump in a single transaction.
5. It runs migrations and starts everything again.

Old unencrypted `*.sql.gz` dumps are still accepted.

**Practise a restore once a month.** A backup you have never restored is only a hope. The server cannot check its own backups by decrypting them (it has no private key), so this is the only proof that they work. CI runs the same round trip on every push (`make test-backups` locally).

### Moving to a new VM

Run steps 1–6 on the new VM, copy `.env`, deploy, then restore with `restore-db.sh latest --identity ...`. Copy media with `docker run --rm -v micky_mediadata:/data alpine tar -C /data -cz . | ssh newvm 'docker run --rm -i -v micky_mediadata:/data alpine tar -C /data -xz'` (or, if the old VM is gone, `restore-media.sh`). Finally, point DNS at the new IP.

## 10. Updating

| Task | How |
|---|---|
| Ship new code | Merge to `main`. CI runs, images are built, and the VM updates itself |
| Roll back | **Actions → Deploy → Run workflow**, `ref_tag` = an older commit SHA (its images are still in ghcr.io), or on the VM: `scripts/deploy.sh <old-sha>` |
| Change a setting | Edit `/opt/micky/.env`, then `docker compose up -d`. A **new** setting must also be listed for its service in `docker-compose.yml` (step 5) |
| Update the server scripts | CI no longer copies them. From your laptop: `scp -i ~/.ssh/micky_vm scripts/*.sh ubuntu@<VM_IP>:/opt/micky/scripts/`. If `deploy-gate.sh` or `server-setup.sh` changed, also run `sudo bash /opt/micky/scripts/server-setup.sh` |
| Try a Content-Security-Policy change safely | Set `CSP_REPORT_ONLY=1` on the `web` service for one deploy: browsers log violations in the console without blocking. Remove it once the console is clean |
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
| `migrate` exits with an error | `docker compose logs migrate`. Usually a wrong `POSTGRES_PASSWORD` after the volume was first created; the password is fixed at first start. Fix `.env` to the original, or (only if empty) `docker compose down && docker volume rm micky_pgdata` |
| Deploy job: `Permission denied (publickey)` | `SSH_PRIVATE_KEY` is not the private half of the key in `~/.ssh/authorized_keys` on the VM, or `SSH_USER` is wrong |
| Deploy job: `Host key verification failed` | `SSH_KNOWN_HOSTS` is stale (VM recreated). Re-run `ssh-keyscan -H <VM_IP>` |
| Deploy job: `deploy-gate: refused: ...` | The gate rejected the request. `... is not allowed` names the compose setting it refused (images must be `${IMAGE_PREFIX}/micky-*` or the pinned official ones). `unknown command`: the workflow and the gate are out of step; copy the scripts and re-run `server-setup.sh` |
| Deploy job: `Permission denied` after the gate was added | The `authorized_keys` line must start with `command="/usr/local/sbin/micky-deploy-gate",restrict` and the gate must exist (`ls -l /usr/local/sbin/micky-deploy-gate`) |
| Backup: `set BACKUP_AGE_RECIPIENTS` | Put the `age1...` public key from step 4.1 in `.env`. Backups are never stored unencrypted |
| Backup: `age is not installed` | `sudo apt-get install -y age` (or re-run `server-setup.sh`) |
| Media backup: `would pass BACKUP_MEDIA_MAX_GB` | The free tier is nearly full. See "What this costs" in section 9 |
| Restore: `could not decrypt` | Wrong private key. Each key only opens backups made with its own public key |
| Browser console: `Refused to load ... Content Security Policy` | A new third party was added without updating `apps/web/lib/csp.ts` (and the fallback in `infra/Caddyfile`) |
| `docker compose pull`: `denied` / `unauthorized` | Packages are private and you're pulling by hand. Make them public or `docker login ghcr.io` |
| `exec format error` | An image was built for the wrong CPU. The deploy workflow builds both; never push a laptop-built amd64-only image to the arm VM |
| Web app calls `localhost:4000` | The web container gets `PUBLIC_API_URL=https://${API_DOMAIN}` from the compose file. Check `API_DOMAIN` in `.env`, then `docker compose up -d web` and `curl https://<WEB_DOMAIN>/runtime-config.js` |
| Login works but you're logged out after 15 min | The refresh cookie isn't reaching the API: web and API must share a site (`x.com` + `api.x.com`) and both be HTTPS |
| Uploads stay "processing" | `docker compose logs worker verifier`. Check the verifier is up and `INTERNAL_TOKEN` is the same for both (it's one variable in `.env`) |
| Worker logs `INTERNAL_TOKEN is required in production` / API logs `JWT_ACCESS_SECRET is required` | That variable is missing from `.env`. Each container only gets its own secrets (step 5) |
| Out of memory / containers killed | `docker stats`. Set `AI_MODEL_ENABLED=false` (saves ~1 GB) or lower limits in `docker-compose.yml` |
| Disk filling up | `df -h`, `docker system df`. Prune: `docker image prune -a --filter until=168h`. Media lives in the `micky_mediadata` volume |
| Oracle emailed about an idle instance | Usage under 20% for 7 days. A loaded AI model normally keeps memory above that. Check `free -h`; a small cron job doing real work also helps |
| Backup: `rclone: command not found` | `sudo apt-get install -y rclone` (or re-run `server-setup.sh`) |
| Backup: `403 AccessDenied` from R2 | The token isn't scoped to `micky-backups`, lacks *Object Read & Write*, or the endpoint has the wrong account ID |

Useful commands:

```bash
cd /opt/micky
docker compose ps
docker compose logs --tail 100 -f api worker
docker compose exec postgres psql -U micky micky     # SQL shell (no public port)
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

#!/usr/bin/env bash
# One-time setup of a fresh Oracle Cloud Ubuntu VM (22.04/24.04, arm64 or amd64).
# Run as the default `ubuntu` user:
#
#   curl -fsSLO https://raw.githubusercontent.com/<you>/<repo>/main/scripts/server-setup.sh
#   sudo bash server-setup.sh
#
# Idempotent: running it again is safe. It:
#   1. installs Docker Engine + Compose plugin (Docker's official apt repo), rclone, cron
#   2. opens 80/tcp, 443/tcp and 443/udp in iptables (Oracle's Ubuntu image
#      REJECTs everything except SSH) and saves the rules across reboots
#   3. adds a 2 GB swap file (headroom for builds/ffmpeg spikes)
#   4. creates /opt/firstframe and /var/backups/firstframe owned by the deploy user
#   5. turns on automatic security updates and installs the nightly backup cron job
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }
DEPLOY_USER="${DEPLOY_USER:-${SUDO_USER:-ubuntu}}"
APP_DIR=/opt/firstframe
export DEBIAN_FRONTEND=noninteractive

echo "==> Packages"
apt-get update -y
apt-get install -y ca-certificates curl gnupg rclone cron unattended-upgrades iptables-persistent

echo "==> Docker Engine (official repository)"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  codename="$(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $codename stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
usermod -aG docker "$DEPLOY_USER"

echo "==> Firewall: allow HTTP/HTTPS (Oracle's image rejects them by default)"
# Live rules: insert just above the first REJECT rule (rule order matters: a rule
# after REJECT is never reached), once.
add_rule() {
  iptables -C INPUT "$@" -j ACCEPT 2>/dev/null && return
  local pos
  pos="$(iptables -L INPUT --line-numbers -n | awk '$2=="REJECT" {print $1; exit}')"
  if [[ -n "$pos" ]]; then iptables -I INPUT "$pos" "$@" -j ACCEPT; else iptables -A INPUT "$@" -j ACCEPT; fi
}
add_rule -p tcp -m state --state NEW -m tcp --dport 80
add_rule -p tcp -m state --state NEW -m tcp --dport 443
add_rule -p udp -m udp --dport 443
# Saved rules (loaded at boot): edit Oracle's file directly instead of
# `netfilter-persistent save`, which would also freeze Docker's own rules into it.
RULES=/etc/iptables/rules.v4
if [[ -f "$RULES" ]] && ! grep -q -- '--dport 443 -j ACCEPT' "$RULES"; then
  backup="$RULES.bak.$(date +%s)"
  cp "$RULES" "$backup"
  awk '!done && /^-A INPUT -j REJECT/ {
         print "-A INPUT -p tcp -m state --state NEW -m tcp --dport 80 -j ACCEPT"
         print "-A INPUT -p tcp -m state --state NEW -m tcp --dport 443 -j ACCEPT"
         print "-A INPUT -p udp -m udp --dport 443 -j ACCEPT"
         done=1 }
       { print }' "$backup" >"$RULES"
  echo "Updated $RULES (backup: $backup)"
fi

echo "==> Swap (2 GB)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
  sysctl -w vm.swappiness=10
  echo 'vm.swappiness=10' >/etc/sysctl.d/99-firstframe.conf
fi

echo "==> Folders"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0750 "$APP_DIR" "$APP_DIR/scripts"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" -m 0700 /var/backups/firstframe
touch /var/log/firstframe-backup.log
chown "$DEPLOY_USER:$DEPLOY_USER" /var/log/firstframe-backup.log

echo "==> Automatic security updates"
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> Nightly database backup (02:30 server time)"
cron_line="30 2 * * * $APP_DIR/scripts/backup-db.sh >> /var/log/firstframe-backup.log 2>&1"
( crontab -u "$DEPLOY_USER" -l 2>/dev/null | grep -v 'scripts/backup-db.sh' || true; echo "$cron_line" ) |
  crontab -u "$DEPLOY_USER" -
systemctl enable --now cron

echo
echo "Done. Log out and back in (so '$DEPLOY_USER' can use docker without sudo), then:"
echo "  docker run --rm hello-world"
echo "  sudo iptables -L INPUT -n --line-numbers   # 80/443 ACCEPT must be above the REJECT line"

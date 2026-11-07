#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 EC2 instance (run as the default user with sudo).
# Installs Docker Engine + Compose plugin and AWS CLI v2, adds 2 GB swap, creates /opt/crm.
set -euo pipefail

# Docker Engine from Docker's apt repository (includes the compose plugin).
sudo apt-get update
sudo apt-get install -y ca-certificates curl unzip
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$(id -un)" # takes effect at the next login

# AWS CLI v2 (ECR login uses the instance role; no access keys on the server).
if ! command -v aws >/dev/null; then
  tmp=$(mktemp -d)
  curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o "$tmp/awscliv2.zip"
  unzip -q "$tmp/awscliv2.zip" -d "$tmp"
  sudo "$tmp/aws/install"
  rm -rf "$tmp"
fi

# 2 GB swap: the 1 GB instance runs web, worker, Valkey and Caddy together.
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  echo 'vm.swappiness=10' | sudo tee /etc/sysctl.d/99-crm-swap.conf >/dev/null
  sudo sysctl --system >/dev/null
fi

# Unattended security updates (Ubuntu default, made explicit).
sudo apt-get install -y unattended-upgrades

sudo mkdir -p /opt/crm
sudo chown "$(id -un)":"$(id -gn)" /opt/crm
chmod 700 /opt/crm
echo "Done. Next: copy compose.yml, Caddyfile and deploy.sh to /opt/crm (runbook step 6)."

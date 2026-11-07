#!/usr/bin/env bash
# Deploy (or roll back to) one image tag on the pilot host:  ./deploy.sh <git-sha>
# Run in /opt/crm. Reads ECR_REGISTRY and SITE_DOMAIN from /opt/crm/deploy.conf.
# Migrations are NOT run here: they go through scripts/db/migrate-supabase.mjs, before deploying.
set -euo pipefail
cd "$(dirname "$0")"

tag=${1:?usage: ./deploy.sh <image tag (git sha)>}
[[ $tag =~ ^[0-9a-f]{7,40}$ ]] || { echo "tag must be a git sha" >&2; exit 1; }
# shellcheck source=/dev/null
. ./deploy.conf
: "${ECR_REGISTRY:?set in deploy.conf}" "${SITE_DOMAIN:?set in deploy.conf}"

for f in shared.env worker.env supabase-ca.crt; do
  [[ -r $f ]] || { echo "missing /opt/crm/$f" >&2; exit 1; }
done
chmod 600 shared.env worker.env

aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin "$ECR_REGISTRY"

export ECR_REGISTRY SITE_DOMAIN IMAGE_TAG=$tag
docker compose pull web worker
docker compose up -d --remove-orphans
echo "$tag" > current-tag

# Wait for the web container's own health check (GET /api/health).
for _ in $(seq 1 30); do
  status=$(docker inspect --format '{{.State.Health.Status}}' "$(docker compose ps -q web)" 2>/dev/null || true)
  [[ $status == healthy ]] && { echo "deployed $tag: web healthy"; docker image prune -f >/dev/null; exit 0; }
  sleep 4
done
echo "web not healthy after 2 minutes; check: docker compose logs web" >&2
exit 1

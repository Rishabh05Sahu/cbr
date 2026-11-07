# ADR-0024: Pilot hosting on one AWS EC2 instance in Mumbai

- **Status:** Proposed (owner chose AWS for the pilot, 2026-11-01; free-plan credits for about 6 months, paid afterwards)
- **Date:** 2026-11-01
- **Amends:** [ADR-0007](ADR-0007-deployment-strategy.md) for the pilot. ADR-0007 already listed AWS Mumbai as a conditional alternative; the database decision (Supabase Free, owner 2026-10-26) is unchanged.

## Context
The web app, the long-running worker and Valkey need a host; Supabase Free covers PostgreSQL and storage only. The pilot must start without recurring cost. Serverless hosts can't run the worker, and the free tiers of Render, Railway and Fly either sleep, have no worker or have no India region.

## Decision
- **One EC2 `t3.micro` (Ubuntu 24.04) in `ap-south-1`**, running web, worker, Valkey (`noeviction`, AOF) and Caddy (automatic HTTPS) with Docker Compose (`deploy/aws/`). 2 GB swap.
- **Images:** the existing `Dockerfile` targets `web` and `worker`, built by GitHub Actions and pushed to **private ECR**, tagged with the commit SHA. GitHub reaches AWS through **OIDC** (no stored keys); the instance pulls through its **instance role** (read-only).
- **Database:** Supabase Free in Mumbai through the session pooler, `verify-full` TLS with the project CA mounted read-only. Migrations stay on `scripts/db/migrate-supabase.mjs`, run from the owner's machine; the server never holds the migrator credentials.
- **Secrets:** only in `/opt/crm/*.env` (mode 600). SMTP credentials and the cleanup role go to the worker only.
- **E-mail:** SES `ap-south-1` as already decided.

## Consequences
- (+) No cost during the credit period; after it, roughly ₹800–1,500/month (instance, disk, public IPv4).
- (+) Same images as ADR-0007, so moving to ECS/Fargate, DigitalOcean or a larger instance later needs no app change.
- (−) **Single host, no redundancy.** An instance failure stops the CRM until it is replaced (target RTO ≤ 4 h: new instance + `deploy.sh`). Valkey data is lost with the disk; queues are rebuilt from the outbox.
- (−) 1 GB RAM is tight; swap absorbs peaks. Upgrade to `t3.small` if swap use stays high.
- (−) SSH is open to the owner's IP only; patching is unattended Ubuntu updates plus monthly reboots.

## Reconsider when
The credits end (choose instance size or move to ADR-0007's DigitalOcean plan), sustained memory pressure, a customer requires HA, or real customer data needs controls beyond a single host.

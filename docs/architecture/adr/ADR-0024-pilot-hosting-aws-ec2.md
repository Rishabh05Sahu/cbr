# ADR-0024: Pilot hosting on AWS EC2 in Mumbai, with QA and production

- **Status:** Proposed (owner chose AWS for the pilot, 2026-11-01; zero-cost start 2026-11-07; separate QA and production 2026-11-11)
- **Date:** 2026-11-01, revised 2026-11-11
- **Amends:** [ADR-0007](ADR-0007-deployment-strategy.md) for the pilot. ADR-0007 already listed AWS Mumbai as a conditional alternative; the database decision (Supabase Free, owner 2026-10-26) is unchanged.

## Context
The web app, the long-running worker and Valkey need a host; Supabase Free covers PostgreSQL and storage only. The pilot must start without recurring cost. Serverless hosts can't run the worker, and the free tiers of Render, Railway and Fly either sleep, have no worker or have no India region. The owner wants every change tested on a QA environment with a test database before it reaches production and its real database.

## Decision
- **Two environments, identical in shape:** QA (`qa` branch, Supabase project `cbr-qa`, synthetic data only) and production (`main`, Supabase project `cbr-prod`). Nothing secret is shared between them.
- **Each runs on one EC2 `t3.micro` (Ubuntu 24.04) in `ap-south-1`**: web, worker, Valkey (`noeviction`, AOF) and Caddy (automatic HTTPS) with Docker Compose (`deploy/aws/`), 2 GB swap. The QA server is stopped when idle.
- **Images:** the existing `Dockerfile` targets `web` and `worker`, built once by GitHub Actions from `qa` and pushed to **private ECR**, tagged with the commit SHA. **Production deploys the same SHA that passed QA**; nothing is rebuilt. GitHub reaches AWS through **OIDC** (no stored keys, `qa` and `main` only); the servers pull through a read-only **instance role**.
- **Database:** Supabase Free in Mumbai through the session pooler, `verify-full` TLS with the project CA mounted read-only. Migrations stay on `scripts/db/migrate-supabase.mjs`, run from the owner's machine with `--target qa|prod`, reading a separate git-ignored file per environment. Production writes need a backup confirmation and the typed project ref. The servers never hold the migrator credentials.
- **Secrets:** only in `/opt/crm/*.env` (mode 600) on each server. SMTP credentials and the cleanup role go to the worker only.
- **Addresses and e-mail at zero cost:** DuckDNS sub-domains and Gmail SMTP app passwords, one per environment. A bought domain and SES (as decided earlier) replace them later by configuration only.

## Consequences
- (+) No cost during the credit period; after it, roughly ₹1,600–2,500/month for both servers (instance, disk, public IPv4), less if QA stays mostly stopped.
- (+) What reaches production is exactly what was tested. Rollback is redeploying the previous SHA.
- (+) Same images as ADR-0007, so moving to ECS/Fargate, DigitalOcean or a larger instance later needs no app change.
- (−) **Single host per environment, no redundancy.** An instance failure stops production until it is replaced (target RTO ≤ 4 h: new instance + `deploy.sh`). Valkey data is lost with the disk; queues are rebuilt from the outbox.
- (−) 1 GB RAM is tight; swap absorbs peaks. Upgrade to `t3.small` if swap use stays high.
- (−) GitHub Free cannot protect `main` on a private repository; production is protected by needing SSH to its server to deploy.
- (−) SSH is open to the owner's IP only; patching is unattended Ubuntu updates plus monthly reboots.

## Reconsider when
The credits end (choose instance sizes or move to ADR-0007's DigitalOcean plan), sustained memory pressure, a customer requires HA, or real customer data needs controls beyond a single host.

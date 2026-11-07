# ADR-0007: Containerised deployment in an Indian region, starting on DigitalOcean BLR1

- **Status:** Proposed. OD-15 accepted as planning default (2026-10-19): DigitalOcean Bengaluru **candidate**, provisional ceiling ₹15,000/month, subject to a priced estimate and Phase 1 verification
- **Date:** 2026-10-19

## Context
We need persistent workers, managed PostgreSQL 18 + a Redis-compatible store + S3-compatible storage in India, operable by a small team, within a provisional pilot budget of ₹15,000/month (excluding telephony, WhatsApp, taxes and variable third-party costs). The 2026-10-19 comparison (deployment-and-operations.md §2) found several India-region providers: DigitalOcean BLR1, AWS Mumbai/Hyderabad, Google Cloud Mumbai/Delhi, Azure Central/South India, and partly verified Akamai/Vultr/E2E. Oracle Cloud lacked PG 18; Railway/Render/Fly have no India region; Vercel workers are beta. **DigitalOcean is chosen as the lowest-effort candidate that fits the budget, not as the only option.**

## Decision
- One Docker image built from the Next.js `output: 'standalone'` build plus a worker entrypoint (Node 24 LTS).
- **Start on DigitalOcean BLR1:** App Platform (web ×2, worker ×1–2), Managed PostgreSQL 18 **single node for the pilot** (standby nodes are leaving Standard Edition; HA via Advanced Edition ≈ ₹27,800/month total exceeds the ceiling), PITR 7 days plus nightly off-site dumps, Managed Valkey (`noeviction` default), Spaces (private). Estimated ≈ ₹7,600/month before GST (deployment §2.1). **Estimate, not a quote.**
- Terraform for all infrastructure. Secrets in the platform secret store. Same image promoted from staging to production.
- **No provider migration is planned.** Containers + Terraform keep AWS Mumbai or GCP Mumbai available as **conditional alternatives**, adopted only if customer requirements, reliability (e.g. affordable HA), security, operational needs or cost justify it.

## Alternatives considered
See deployment-and-operations.md §2: AWS first (more control, more ops), Vercel + external services (split infra, beta workers), non-India PaaS (rejected), self-managed VMs (rejected for production DB).

## Consequences
- (+) Low ops burden and cost for the pilot. India data residency. Portable containers.
- (−) Pilot runs without database HA. Availability target is 99.5%, RTO ≤ 4 h, and the restore drill is mandatory.
- (−) Fewer enterprise security controls than AWS (fine-grained IAM, KMS CMKs, WAF options). We compensate with app-level encryption for secrets and strict access management.
- Verified 2026-10-19: PG 18 on Standard Edition, PITR 7 days, PgBouncer modes, Valkey `noeviction` default, BLR1 availability of PG/Valkey/App Platform/Spaces. **Still UNVERIFIED:** Advanced Edition in BLR1, explicit persistent-worker semantics of App Platform workers, GST treatment. These are confirmed in Phase 1 (S1-18, first bill).

## Reconsider when
A customer contract mandates AWS/Azure controls; scale needs read replicas or partition tooling beyond DO; DO lacks a required service in BLR1; Vercel Daemons become GA in bom1 and an in-region managed Postgres option exists (re-evaluate the DX trade-off).

## References
- DigitalOcean regional availability: https://docs.digitalocean.com/platform/regional-availability/ · PG pricing/edition changes: https://docs.digitalocean.com/products/databases/postgresql/details/pricing/ · PG limits: https://docs.digitalocean.com/products/databases/postgresql/details/limits/ · user privileges (doadmin Bypass RLS): https://docs.digitalocean.com/products/databases/postgresql/how-to/modify-user-privileges/ · Valkey eviction: https://docs.digitalocean.com/products/databases/valkey/how-to/choose-eviction-policies/ · App Platform pricing: https://www.digitalocean.com/pricing/app-platform
- Alternatives: AWS RDS PG versions https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-versions.html · GCP Cloud SQL versions https://docs.cloud.google.com/sql/docs/postgres/db-versions · GCP Memorystore Valkey locations https://docs.cloud.google.com/memorystore/docs/valkey/locations · Azure PG versions https://learn.microsoft.com/en-us/azure/postgresql/flexible-server/concepts-supported-versions
- AWS regional services: https://aws.amazon.com/about-aws/global-infrastructure/regional-product-services/
- Vercel regions: https://vercel.com/docs/regions · Function limits: https://vercel.com/docs/functions/limitations · Daemons: https://vercel.com/kb/guide/vercel-daemons
- Railway regions: https://docs.railway.com/reference/deployment-regions · Render regions: https://render.com/docs/regions · Fly regions: https://docs.fly.io/reference/regions
- Next.js standalone output: https://nextjs.org/docs/app/api-reference/config/next-config-js/output

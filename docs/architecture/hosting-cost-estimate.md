# Hosting Cost Estimate (Pilot), revised 2026-10-20

> **Superseded for the initial pilot (owner, 2026-10-26):** the database target is **Supabase Free**. DigitalOcean options A–C are **not approved**. Free-tier services and limits are in [PHASE-2-M6-READINESS.md](../PHASE-2-M6-READINESS.md) §6. This estimate stays as the record for a later paid stage.

> **Status:** proposed; **nothing recurring has been provisioned.**
> - Recurring production/staging infrastructure needs the owner's written approval (owner instruction B, 2026-10-20).
> - The ceiling is **₹15,000/month**, excluding variable third-party charges, unless the owner approves a change.
> - **Provisional choice for the controlled pilot:** single-node managed PostgreSQL, with the documented backup, restore and availability limitations (§6).
>
> **Basis:**
> - **Prices:** official DigitalOcean pages and the AWS price-list API (ap-south-1), read 2026-10-20 (sources in §8).
> - **Exchange rate:** **1 USD = ₹95.05** (open.er-api.com, 2026-10-20).
> - **GST:** 18%. DigitalOcean bills Indian customers in USD with 18% GST, or under reverse charge with a GSTIN. AWS India bills with 18% GST.
> - **Both pre-tax and GST-inclusive totals are shown.** The owner judged the earlier GST-inclusive total (₹14,914) to leave too little headroom.
>
> **Account-specific facts still to confirm in the DigitalOcean control panel (§2):** whether this account has ever created a PostgreSQL/MySQL cluster, and which plans and standby options the create-cluster page offers it. **Until then, rows that depend on them are marked PENDING.**

## 1. What changed since the previous estimate

1. **DigitalOcean plan changes (effective 15 October 2026 for new accounts, 30 November 2026 for all accounts).** DigitalOcean's PostgreSQL pricing page says "new Standard Edition clusters cannot use plans with more than 4 GiB of RAM or add standby or read-only nodes".
   - Accounts that have **never** created a PostgreSQL or MySQL cluster were affected from **15 October**.
   - Every other account is affected from **30 November**. A cluster created and later **deleted still counts** as history (third-party summary of DigitalOcean's notice; confirm in the panel).
   - **Existing clusters keep** their standby nodes.
2. **High availability now means Advanced Edition** for new clusters: from **$130/month for an 8 GiB / 2 vCPU primary**, and standby nodes bill at the primary's rate. The earlier finding ("a standby costs the same as a $30 Standard primary", ≈ ₹2,900) **only holds for an account still before its cutoff** and for a cluster created before it. **It must not be assumed.**
3. **Email:** SES Essentials pricing ($0.16 per 1,000) is now used for ~5,000 emails ($0.80). Production rises from $92.82 to **$93.12**.

## 2. Account eligibility (to verify before any recurring decision)

| Question | How to establish it | Result |
|---|---|---|
| Has this account ever created a PostgreSQL or MySQL cluster (including deleted ones)? | Control panel: Billing → invoice history (Managed Database line items); Databases page; ask DigitalOcean support for a written answer if unclear | **PENDING**: no access to the account from this workstation yet (no `doctl` credentials, browser extension not connected) |
| Does the create-cluster page offer standby nodes for **Standard** PostgreSQL in BLR1? | Control panel → Create → Databases → PostgreSQL → BLR1. Look at the "standby nodes" option and the plan list | **PENDING** |
| Is PostgreSQL **18** offered in BLR1? (Our migrations use PostgreSQL 18's built-in `uuidv7()`) | Same page, version list | **PENDING** (community posts suggest 18 is the default; unconfirmed) |
| Smallest **Advanced Edition** plan and price in BLR1 | Same page | Docs: from $130/month (8 GiB); **PENDING** in the panel |

**Note:** the temporary S1-18 test cluster (instruction A) **will itself create cluster history** on this account. Whether that changes the account's cutoff date (15 Oct vs 30 Nov) once 15 October has passed is unclear. Confirm with DigitalOcean support **before** relying on Standard-Edition standby for HA.

## 3. Monthly cost comparison (pilot)

**Staging usage assumptions:**
- **always on:** 730 h;
- **on demand:** about **25%** of the month, created for S1/restore drills and pre-release checks and destroyed afterwards. Resources are billed hourly up to the monthly cap.

| Option | Production DB | Staging | USD/month | ₹ pre-tax | ₹ incl. 18% GST | Headroom vs ₹15,000 (pre-tax / incl. GST) |
|---|---|---|---|---|---|---|
| **A. Single node (previous plan)** | DO Standard 2 GiB, single node ($30.45) | always on | 133.27 | **12,667** | **14,947** | ₹2,333 / ₹53 |
| **A1. Single node, staging on demand (recommended)** | as A | 25% | 103.16 | **9,805** | **11,570** | **₹5,195 / ₹3,430** |
| A2. A1 + one web container instead of two | as A | 25% | 91.16 | 8,665 | 10,224 | ₹6,335 / ₹4,776 |
| **B. DO Standard + 1 standby: PENDING eligibility** | 2 × $30.45 | always on | 163.72 | 15,562 | 18,363 | **−₹562** / −₹3,363 |
| B1. as B, staging on demand | 2 × $30.45 | 25% | 133.61 | 12,699 | 14,985 | ₹2,301 / ₹15 |
| **C. DO Advanced Edition HA** (smallest documented: 8 GiB primary + standby) | 2 × $130 | 25% | 332.71 | 31,624 | 37,316 | **−₹16,624** |
| **D. Alternative provider: AWS Mumbai** (RDS PostgreSQL **Multi-AZ** db.t4g.small, ECS Fargate, ALB, ElastiCache Valkey) | Multi-AZ $69.18 incl. 30 GB gp3 | 25% (single-AZ db.t4g.micro) | 173.79 | 16,519 | 19,492 | **−₹1,519** |
| D (production only, no staging) | as D | none | 155.18 | 14,749 | 17,404 | ₹251 (pre-tax) |

### 3.1 Option A1 line items (recommended provisional)

| # | Component | Configuration | USD/month |
|---|---|---|---|
| 1 | Web | App Platform, 2 × 1 vCPU / 1 GiB ($12 each) | 24.00 |
| 2 | Worker | App Platform worker 1 GiB | 10.00 |
| 3 | PostgreSQL 18 | DO Standard, **single node** 2 GiB / 1 vCPU, 30 GiB, 7-day PITR, 47 connections | 30.45 |
| 4 | Valkey | DO managed 1 GiB (`noeviction`) | 15.00 |
| 5 | Spaces | encrypted nightly `pg_dump` copies (and Phase 2 files later) | 5.00 |
| 6 | Container registry | DOCR Basic (private; images are confidential, see secrets review) | 5.00 |
| 7 | Uptime checks | 3 checks (1 free) | 2.00 |
| 8 | Error tracking | Sentry Developer (free) | 0.00 |
| 9 | Email | SES ap-south-1, ~5,000/month, Essentials ([email-ses-setup.md](email-ses-setup.md)) | 0.80 |
| 10 | Domain | .com, ~$10.46/year | 0.87 |
| | **Production** | | **93.12** (₹8,851) |
| 11–13 | **Staging on demand** | web+worker 2 × 512 MiB ($10), PG single node 1 GiB ($15.15), Valkey 1 GiB ($15) × 25% | **10.04** (₹954) |
| | **Total** | | **103.16 (₹9,805 pre-tax; ₹11,570 incl. GST)** |

### 3.2 Option D (AWS Mumbai) line items (alternative if HA becomes a requirement)

From the AWS price-list API, ap-south-1, on-demand, 730 h:

| Item | USD/month |
|---|---|
| Fargate ARM, web 2 × (0.5 vCPU, 1 GB) at $0.02383/vCPU-h, $0.00261/GB-h | 21.21 |
| Fargate worker (0.25 vCPU, 0.5 GB) | 5.30 |
| Application Load Balancer $0.0239/h + ~1 LCU × $0.008/h | 23.29 |
| RDS PostgreSQL db.t4g.small **Multi-AZ** $0.084/h + 30 GB gp3 × $0.262 | 69.18 |
| ElastiCache Valkey cache.t4g.micro $0.016/h (single node) | 11.68 |
| Public IPv4 × 5 × $0.005/h (ALB + tasks; avoids a ~$41 NAT gateway) | 18.25 |
| ECR, S3 backups, CloudWatch Logs (estimate), SES, Route 53, domain | 6.27 |
| **Production** | **155.18** |
| Staging on demand (25%, single-AZ db.t4g.micro) | 18.62 |

**Option D trade-offs:**
- (+) Real Multi-AZ failover, typically 1–2 minutes.
- (+) SES in the same account.
- (−) It would be a **change to the approved architecture** (ADR-0007: DigitalOcean App Platform), needing the owner's approval and a new deployment design (VPC, IAM, ECS, ALB, Secrets Manager). That means more operations work.
- (−) It exceeds the ceiling with staging.
- **Mixing DigitalOcean compute with an RDS database is not recommended:**
  - cross-provider latency on every tenant transaction;
  - a publicly reachable database;
  - App Platform has no fixed egress IP without a $25 add-on.

## 4. Operational trade-offs

| | A1 single node | B Standard + standby | C Advanced HA | D AWS Multi-AZ |
|---|---|---|---|---|
| Unplanned DB outage (node failure) | Provider replaces the node / restore from backup; **minutes to hours**. Target 4 h RTO (to be measured on staging) | Automatic failover to standby, typically seconds to minutes | Consensus-based automatic failover; pooler endpoint stays stable | Automatic Multi-AZ failover (~1–2 min) |
| Maintenance windows | Brief downtime during provider updates | Failover-based, shorter | Shortest | Failover-based |
| Data loss on node failure (RPO) | Up to the provider's WAL shipping interval. **Not** the 7-day PITR window, which is how far back a restore can go. **To be measured** (runbook §3) | Near zero (synchronous/asynchronous replication; to verify) | Near zero | Near zero (synchronous standby) |
| Cost vs ceiling | **Fits with ₹5,195 pre-tax headroom** | Fits only with on-demand staging, ~₹15 headroom incl. GST; **eligibility PENDING**; tied to a grandfathered configuration | Does not fit | Does not fit with staging |
| Operational effort | Lowest | Low | Low | Highest (new platform) |

## 5. Recommendation

1. **Pilot:** **Option A1**, single-node DigitalOcean PostgreSQL with on-demand staging.
   - ≈ **₹9,805/month pre-tax (₹11,570 incl. GST)**.
   - Headroom ≈ ₹5,195 pre-tax / ₹3,430 incl. GST. That leaves room for exchange-rate moves (§7), a 4 GiB DB upgrade if needed (+₹2,894), or Sentry Team (+₹2,756).
   - This is the owner's provisional choice; the limitations are in §6.
2. **HA:**
   - **Not affordable within ₹15,000** on Advanced Edition (C) or AWS (D) with staging.
   - Option B is only possible if the panel confirms eligibility, and it would leave almost no headroom including GST.
   - **Decide HA before scaling past the pilot** (more brokerages, or real-time calling in Phase 6). Expect ≈ ₹31,600/month on DigitalOcean Advanced, or a move to AWS.
3. **Next step for this estimate:** inspect the account in the control panel (§2) and update the PENDING rows. **No recurring resource will be created without the owner's written approval.**

## 6. Single-node limitations (accepted by the owner on 2026-10-19, restated)

- **Availability target 99.5%.** A node failure means an outage until the provider replaces the node or a restore completes. **Target RTO 4 h, not yet measured on managed infrastructure.**
- **PITR window 7 days.** This is how far back a restore can go, **not** the data-loss window. Measured locally: **10.8 s** RPO for WAL archiving with a 30 s archive timeout ([recovery-test-results.md](recovery-test-results.md)). The provider's RPO must be measured on staging (gate G4).
- **Off-site copy:** nightly encrypted `pg_dump` to Spaces (a separate DigitalOcean service, same provider). Encrypted before upload; keys outside DigitalOcean.
- **No read replicas.** Reporting load shares the primary (acceptable at pilot scale; 250k-lead tests p95 ≤ 32 ms locally).

## 7. Sensitivities

- **Exchange rate:** each +₹1 per USD adds ≈ ₹103/month to A1. At ₹100/USD, A1 = ₹10,316 pre-tax.
- **Staging always on** instead of on demand: +₹2,862/month (A instead of A1).
- **Connection budget:** the 2 GiB DB allows 47 connections. Pool caps per process are configured (2 web × (5 + 3 + 2) + worker 5 = 25). PgBouncer transaction pooling is tested in the S1-18 run before relying on it.
- **Not included:**
  - DigitalOcean dedicated egress IP ($25);
  - SES dedicated IP;
  - Sentry Team ($29);
  - paid log retention beyond defaults;
  - card forex fees.

## 8. Sources (read 2026-10-20)

- **DigitalOcean PostgreSQL pricing (plan-change wording, Advanced Edition from $130):** https://docs.digitalocean.com/products/databases/postgresql/details/pricing/
- **DigitalOcean Managed Databases pricing (Standard 1/2/4 GiB: $15.15/$30.45/$60.90; hourly $0.02254/$0.04531/$0.09063):** https://www.digitalocean.com/pricing/managed-databases
- **DigitalOcean PostgreSQL limits (connections 22/47; no superuser):** https://docs.digitalocean.com/products/databases/postgresql/details/limits/
- **Plan-change summary incl. "a deleted cluster still counts"** (third-party; confirm with DigitalOcean): https://privatedevops.com/news/digitalocean-database-plan-changes-october-15
- **DigitalOcean India GST:** https://docs.digitalocean.com/platform/billing/taxes/ind/
- **AWS price-list API, ap-south-1:** `https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/{AmazonRDS,AmazonECS,AmazonElastiCache,AWSELB,AmazonECR,AmazonSES}/current/ap-south-1/index.csv`
- **Other DigitalOcean items (App Platform, Spaces, DOCR, Uptime):** as in the 2026-10-20 first estimate; unchanged list prices
- **Exchange rate:** https://open.er-api.com/v6/latest/USD (₹95.0525, 2026-10-20 00:02 UTC)

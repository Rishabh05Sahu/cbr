# Runbook: production on AWS EC2 (Mumbai) at crm.crystalbricksroofs.com

> **Status (2026-11-15): approved, not yet executed.** The owner approved the "$25 plan" (gate G1, at most about $25/month). Decision record: [ADR-0024](../architecture/adr/ADR-0024-pilot-hosting-aws-ec2.md), amended 2026-11-15.
> **Secrets:** never in Git, chat or tickets. They live only in your password manager, in `/opt/crm/*.env` on the server, and in the git-ignored `.env.supabase-prod` on your PC.
> **Users are in Dubai.** Mumbai is the closest healthy AWS region (about 25–35 ms away). The UAE and Bahrain regions were damaged in March 2026 and AWS advised customers to move away; check the AWS Health Dashboard before ever choosing them.

## 1. Environments

| | Local (your PC) | **QA** | **Production** |
|---|---|---|---|
| Purpose | Write code, fast tests | Test the finished change online | Real users |
| Branch | `qa` | `qa` (Vercel deploys it) | `main` |
| Hosting | `pnpm dev` | Vercel Hobby, functions in `syd1` | EC2 `cbr-prod`, `t3.small`, Mumbai |
| Database + files | Docker Postgres (`pnpm db:up`) | Supabase test project (Sydney), synthetic data only | Supabase `cbr-prod`, **Mumbai**, Free plan |
| Worker | `pnpm worker:dev` | Run from your PC when e-mails are needed | Always on, in Docker on the server |
| Address | `localhost:3000` | `https://cbr-liart.vercel.app` | `https://crm.crystalbricksroofs.com` |
| E-mail | Mailpit | Gmail app password | Google Workspace, `noreply@crystalbricksroofs.com` |
| Migrations | `pnpm db:migrate` | `migrate-supabase.mjs` (acceptance `.env`) | `migrate-supabase.mjs --target prod` |

**Rules**
- QA and production share nothing secret: different Supabase projects, passwords and `BETTER_AUTH_SECRET`.
- **Real customer data never goes to QA.**
- Production runs the images built from the commit that passed QA (same SHA).
- The company website (`www`, root domain) and Google Workspace e-mail are **not touched**. In GoDaddy only the `crm` records below are added.

### 1.1 Cost (owner approved up to about $25/month)

| Item | Monthly (approximate, on-demand) |
|---|---|
| EC2 `t3.small` (2 vCPU, 2 GB) | ~$16.50 |
| 20 GiB gp3 disk | ~$1.80 |
| Elastic IP (public IPv4) | ~$3.65 |
| ECR images (lifecycle keeps 30) | ~$0.10 |
| Supabase Free (Mumbai), CloudFront free tier, CloudWatch free tier, Sentry free, Workspace SMTP | $0 |
| **Total** | **≈ $22** |

Free-plan credits, if the account has them, cover the first months. **Upgrade to a paid AWS plan before the free plan ends**: a free-plan account that is not upgraded is closed and its resources are deleted.

**Known limits of this plan (owner's choice, 2026-11-15):** a single server with no redundancy; Supabase Free limits (500 MB database, 1 GB files, pauses after 7 days idle); **no backups for now**. Before real customer data, add the nightly dump (supabase-free-setup.md §8, about $0.10/month in S3) and run the restore drill (G4).

## 2. AWS account (owner, once)

1. Sign up at aws.amazon.com. Root user: MFA on, no access keys. Create an IAM Identity Center user for daily work.
2. **Billing → Budgets:** one monthly cost budget of **$25**, with alerts at 80% and 100% (actual) and 100% (forecast).
3. Region for everything: **Asia Pacific (Mumbai) ap-south-1** (top-right region menu).

## 3. Images and access (once)

1. **ECR → Create repository** twice, private, *scan on push*: `cbr-crm-web` and `cbr-crm-worker`. Lifecycle policy on each (keeps rollback versions available):
   ```json
   { "rules": [{ "rulePriority": 1, "selection": { "tagStatus": "any", "countType": "imageCountMoreThan", "countNumber": 30 }, "action": { "type": "expire" } }] }
   ```
2. **GitHub → AWS without stored keys (OIDC).** IAM → Identity providers → Add provider: OpenID Connect, URL `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
3. **IAM → Roles → Create role → Web identity**, that provider, name `cbr-crm-github-release`. Trust policy (builds may run from `qa` and `main` only):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": { "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com" },
       "Action": "sts:AssumeRoleWithWebIdentity",
       "Condition": {
         "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
         "StringLike": {
           "token.actions.githubusercontent.com:sub": [
             "repo:Rishabh05Sahu/cbr:ref:refs/heads/qa",
             "repo:Rishabh05Sahu/cbr:ref:refs/heads/main"
           ]
         }
       }
     }]
   }
   ```
   Inline policy (push to the two repositories only):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*" },
       { "Effect": "Allow",
         "Action": ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
                    "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage"],
         "Resource": ["arn:aws:ecr:ap-south-1:<account-id>:repository/cbr-crm-web",
                      "arn:aws:ecr:ap-south-1:<account-id>:repository/cbr-crm-worker"] }
     ]
   }
   ```
4. **GitHub → Settings → Secrets and variables → Actions → Variables** (not secrets): `AWS_RELEASE_ROLE_ARN` (the role's ARN) and `ECR_REGISTRY` (`<account-id>.dkr.ecr.ap-south-1.amazonaws.com`).
5. **GitHub → Settings → General:** visibility **Private**.
6. **Server role:** IAM → Roles → Create role → AWS service → EC2, managed policy `AmazonEC2ContainerRegistryReadOnly`, name `cbr-crm-ec2`. The production server uses it.

## 4. Production

### 4.1 Server

1. **EC2 → Launch instance**, name `cbr-prod`:
   - Image **Ubuntu Server 24.04 LTS (x86_64)**; type **t3.small**. The images are x86_64, so not `t4g`.
   - Key pair: create one (ED25519); keep the `.pem` outside the repository.
   - Security group: **SSH 22 from My IP only**; HTTP 80 and HTTPS 443 from anywhere.
   - Storage 20 GiB gp3. Advanced → IAM instance profile `cbr-crm-ec2`, metadata **V2 only**.
2. **Elastic IP:** allocate one and associate it with `cbr-prod` (the address survives restarts and stops).
3. **GoDaddy → My Products → crystalbricksroofs.com → DNS → Add New Record:**

   | Type | Name | Value | TTL |
   |---|---|---|---|
   | `A` | `crm` | the Elastic IP | 1/2 hour |

   Add only this record. Leave every existing record (`@`, `www`, MX, TXT) as it is. Check from your PC: `nslookup crm.crystalbricksroofs.com 8.8.8.8` shows the Elastic IP (usually within minutes).
4. From your PC (PowerShell, in the repository folder):
   ```powershell
   scp -i <key.pem> deploy/aws/compose.yml deploy/aws/Caddyfile deploy/aws/deploy.sh deploy/aws/server-setup.sh ubuntu@<elastic-ip>:~/
   ssh -i <key.pem> ubuntu@<elastic-ip>
   ```
   On the server:
   ```sh
   bash ~/server-setup.sh
   mv ~/compose.yml ~/Caddyfile ~/deploy.sh /opt/crm/
   exit   # log in again so the docker group applies
   ```

### 4.2 Database and storage (gated)

1. **Supabase → New project** `cbr-prod`, region **Mumbai**, free plan. Store its database password in your password manager.
2. On your PC, create **`.env.supabase-prod`** in the repository folder (git-ignored). It holds **only** the `ACCEPTANCE_*` block from `.env.example`, filled for this project as in [supabase-free-setup.md](supabase-free-setup.md) §4 (five new role passwords, pooler URLs, admin login, CA file path). Generate new passwords for production (never reuse the test project's).
3. Run the same steps as supabase-free-setup.md §4–§6, adding `--target prod`. Each **APPROVAL** step there still needs the owner's go-ahead:
   ```sh
   node scripts/db/supabase-acceptance-preflight.mjs --target prod --config
   node scripts/db/supabase-acceptance-preflight.mjs --target prod --read-only
   node scripts/db/bootstrap-supabase.mjs --target prod --run
   node scripts/db/bootstrap-supabase.mjs --target prod --run-extensions
   node scripts/db/migrate-supabase.mjs --target prod --status
   node scripts/db/migrate-supabase.mjs --target prod --deploy
   node scripts/db/migrate-supabase.mjs --target prod --verify
   ```
   With `--target prod`, every write (`--run`, `--run-extensions`, `--deploy`, `--record-committed`) first asks whether a backup was taken, then for the first four characters of the production project ref. It refuses without an interactive terminal.
4. Private storage bucket in this project: [supabase-storage-setup.md](supabase-storage-setup.md).
5. Download the project's CA certificate (**Database Settings → SSL Configuration**) and copy it to the server as `/opt/crm/supabase-ca.crt`.

> **New migrations:** `migrate-supabase.mjs` only runs migrations pinned in its reviewed list (today 0001–0028; 0001–0027 were rehearsed on PostgreSQL 17 on 2026-11-11 and 0028 was applied to the test project on 2026-11-12), and `verify-supabase.sql` checks for exactly those. Every new migration (0029 onwards) must be reviewed, pinned and added to the verification before it can be deployed to production.

### 4.3 E-mail (Google Workspace)

1. **admin.google.com → Directory → Users →** the user who will send for the CRM **→ User information → Alternate email addresses (aliases)** → add `noreply@crystalbricksroofs.com`.
2. As that user: turn on **2-Step Verification**, then **myaccount.google.com/apppasswords** → create "CRM". If the page is missing, a Workspace admin must allow app passwords in the Security settings.
3. In that user's Gmail: **Settings → Accounts → Send mail as → Add another email address** → `noreply@crystalbricksroofs.com` (an alias, so no extra verification).
4. Values: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587` and `EMAIL_FROM=CBR Property CRM <noreply@crystalbricksroofs.com>` go in `shared.env`; `SMTP_USER=<that user's address>` and `SMTP_PASSWORD=<16-letter app password, no spaces>` go in `worker.env`.

The domain's SPF record already covers Google (an `include:` managed by GoDaddy). Turning on **DKIM** in the Workspace admin (Apps → Gmail → Authenticate email) improves delivery. Later, SES with this domain ([email-ses-setup.md](../architecture/email-ses-setup.md)) changes only these values.

### 4.4 Server configuration (secrets)

On the server, in `/opt/crm`, create these with `nano` from the `.example` files in `deploy/aws/`, then `chmod 600 *.env`:

| File | Contents |
|---|---|
| `deploy.conf` | `ECR_REGISTRY`, `SITE_DOMAIN` (`crm.crystalbricksroofs.com`) |
| `shared.env` | Production's role URLs (`crm_app`, `crm_auth`, `crm_platform`), `BETTER_AUTH_URL` (`https://<SITE_DOMAIN>`), a new `BETTER_AUTH_SECRET` (never the Vercel one), Supabase storage, SMTP host and port |
| `worker.env` | Workspace user and app password (§4.3), `CLEANUP_DATABASE_URL` |

Every database URL ends with `?sslmode=verify-full&sslrootcert=/run/crm/supabase-ca.crt`. The app refuses to start if a URL logs in as `postgres` or `crm_migrator`.

## 5. Everyday flow

```
1. PC          work on qa → pnpm test (local Docker DB) → git push
2. GitHub      ci runs on every push to qa (tests, lint, build)
3. QA          (migrations first: node scripts/db/migrate-supabase.mjs --deploy)
               Vercel deploys qa → test on its preview or https://cbr-liart.vercel.app
4. Build       Actions → release → Run workflow on qa → note the SHA in the summary
5. Production  only when QA is OK:
               a. git checkout main && git merge --ff-only qa && git push   (main = tested commit)
               b. (migrations?) node scripts/db/migrate-supabase.mjs --target prod --deploy
               c. on cbr-prod: bash /opt/crm/deploy.sh <SHA from step 4>
               d. check https://crm.crystalbricksroofs.com/api/health and sign in
```

- **Same commit everywhere:** the images in step 5c are built from the commit tested in step 3.
- **`--ff-only`** keeps `main` exactly at the tested commit. If it fails, `main` has a commit that `qa` lacks: merge `main` into `qa`, test again, then repeat.
- **Migrations must be backward-compatible** with the version currently running, because the database is updated a few minutes before the new app starts.
- **Rollback:** `bash /opt/crm/deploy.sh <previous SHA>` (in `/opt/crm/current-tag` before each deploy). It does not undo a migration.

## 6. Checks after a deploy

- `https://<SITE_DOMAIN>/api/health` returns `{"status":"ok"}`.
- Use Forgot password with your admin e-mail: the e-mail arrives from `noreply@crystalbricksroofs.com`.
- `docker compose logs worker` shows `importCommitStrategy: "set"` and no errors.
- On a phone (390 px), the everyday screens work.

## 7. Operating

- **Logs:** `cd /opt/crm && docker compose logs -f web worker` (rotated at 10 MB × 5). CloudWatch shipping and Sentry error alerts are follow-ups (free tiers).
- **Memory:** `free -h`. If swap use stays high or pages slow down, change the server to `t3.medium` (stop → change type → start; about +$16/month, needs the owner's approval).
- **Supabase pauses a project after 7 days without activity.** Daily use keeps production awake; if it pauses, restore it from the Supabase dashboard.
- **Backups:** none for now (owner's choice), and Supabase Free keeps none. Add the nightly dump before real customer data (§1.1).
- **SSH:** if your home IP changes, update the security group's SSH rule.
- **Updates:** Ubuntu security updates install automatically; `sudo reboot` monthly when `/var/run/reboot-required` exists.

## 8. Speed-up for Dubai: CloudFront (after launch, measured)

The site works fully without it. CloudFront terminates TLS at its Dubai and Fujairah edges and serves `/_next/static/*` from them. Do it after the launch has been measured, so the gain is measured too:
1. Request a certificate for `crm.crystalbricksroofs.com` in **ACM, region us-east-1** (CloudFront's requirement), DNS validation: add the `CNAME` it shows in GoDaddy.
2. Add an origin record in GoDaddy (`A`, `origin-crm`, the Elastic IP) and serve that name from Caddy as well.
3. Create the distribution: origin `origin-crm.crystalbricksroofs.com` (HTTPS only); default behaviour **CachingDisabled** forwarding all cookies, query strings and headers; `/_next/static/*` with **CachingOptimized**.
4. The app must accept the browser's `Origin` behind the proxy (Next.js server actions and the auth library check it): a tested app setting on QA before switching.
5. Switch: change the GoDaddy `crm` record from `A` to `CNAME` → the distribution's `*.cloudfront.net` name.

## 9. Before real customer data

Production holds the owner's own test data only until the gates in [staging-preparation.md](staging-preparation.md) §0 are met: real-route isolation passes (G3), a restore drill with measured RPO (G4, which needs backups), and the legal review (G5). Customers are in the UAE, so G5 now includes the **UAE PDPL**: data of UAE residents hosted in India is a cross-border transfer; clients in DIFC or ADGM fall under those free zones' own laws.

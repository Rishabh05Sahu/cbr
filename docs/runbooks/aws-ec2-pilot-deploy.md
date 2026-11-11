# Runbook: QA and production on AWS EC2 (Mumbai)

> **Status (2026-11-11): prepared, not executed.** Nothing has been created in AWS, Supabase or DuckDNS. Decision record: [ADR-0024](../architecture/adr/ADR-0024-pilot-hosting-aws-ec2.md).
> **Secrets:** never in Git, chat or tickets. They live only in your password manager, in `/opt/crm/*.env` on each server, and in the git-ignored `.env.supabase-qa` / `.env.supabase-prod` on your PC.

## 1. Environments

| | Local (your PC) | **QA** | **Production** |
|---|---|---|---|
| Purpose | Write code, fast tests | Test the finished change online | Real users, real data |
| Branch | `qa` | `qa` | `main` |
| Database | Docker Postgres (`pnpm db:up`) | Supabase project `cbr-qa`, synthetic data only | Supabase project `cbr-prod` |
| Server | — | EC2 `cbr-qa` (stop it when idle) | EC2 `cbr-prod` |
| Address | `localhost:3000` | `https://cbr-crm-qa.duckdns.org` | `https://cbr-crm.duckdns.org` |
| E-mail | Mailpit | Gmail account #1 (app password) | Gmail account #2 (app password) |
| Migrations | `pnpm db:migrate` | `migrate-supabase.mjs --target qa` | `migrate-supabase.mjs --target prod` |

**Rules**
- QA and production share nothing secret: different Supabase projects, passwords, `BETTER_AUTH_SECRET`, Gmail accounts. The scripts refuse two targets on the same project or sharing a role password.
- **Real customer data never goes to QA.** Use `pilot/synthetic-corpus`.
- Production runs exactly the images that passed QA (same commit SHA), never a fresh build.

### 1.1 Cost (zero at the start)

| Item | Free start | Later |
|---|---|---|
| 2 servers, disks, public IPs, ECR | AWS free-plan credits; stopping the QA server when idle saves credits | Paid AWS plan, about ₹1,600–2,500/month for both |
| Addresses + HTTPS | Two DuckDNS sub-domains, Let's Encrypt via Caddy | Own domain (~₹800–1,000/year) |
| E-mail | Gmail SMTP, about 500 mails/day per account | Amazon SES with your domain |
| Database + files | Two Supabase Free projects | Supabase Pro |
| Code + builds | GitHub Free, private repo | Same |

AWS asks for a card at sign-up (a small verification charge is refunded). **Upgrade to a paid AWS plan before the free plan ends**: a free-plan account that is not upgraded is closed and its resources are deleted.

## 2. AWS account (owner, once)

1. Sign up at aws.amazon.com, **free plan**. Root user: MFA on, no access keys. Create an IAM Identity Center user for daily work.
2. **Billing → Budgets:** alerts at $5 and $20.
3. Region for everything: **Asia Pacific (Mumbai) ap-south-1**.

## 3. Shared by both environments (once)

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
6. **Server role:** IAM → Roles → Create role → AWS service → EC2, managed policy `AmazonEC2ContainerRegistryReadOnly`, name `cbr-crm-ec2`. Both servers use it.

## 4. Each environment (do QA first, then production)

Replace `<env>` with `qa` or `prod`.

### 4.1 Server

1. **EC2 → Launch instance**, name `cbr-<env>`:
   - Image **Ubuntu Server 24.04 LTS (x86_64)**; type **t3.micro** (*Free tier eligible*). The images are x86_64, so not `t4g`.
   - Key pair: create one per server (ED25519); keep the `.pem` outside the repository.
   - Security group: **SSH 22 from My IP only**; HTTP 80 and HTTPS 443 from anywhere.
   - Storage 20 GiB gp3. Advanced → IAM instance profile `cbr-crm-ec2`, metadata **V2 only**.
2. **Elastic IP:** allocate and associate (the address survives restarts and stops).
3. **DuckDNS** (duckdns.org, sign in with GitHub or Google): sub-domain `cbr-crm-qa` for QA, `cbr-crm` for production. Put the server's Elastic IP in *current ip* and press *update ip*. No updater is needed.
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

1. **Supabase → New project** `cbr-<env>`, region **Mumbai**, free plan. Store its database password in your password manager.
2. On your PC, create **`.env.supabase-<env>`** in the repository folder (git-ignored). It holds **only** the `ACCEPTANCE_*` block from `.env.example`, filled for this project as in [supabase-free-setup.md](supabase-free-setup.md) §4 (five new role passwords, pooler URLs, admin login, CA file path). Generate new passwords for each environment.
3. Run the same steps as supabase-free-setup.md §4–§6, adding `--target <env>`. Each **APPROVAL** step there still needs the owner's go-ahead:
   ```sh
   node scripts/db/supabase-acceptance-preflight.mjs --target <env> --config
   node scripts/db/supabase-acceptance-preflight.mjs --target <env> --read-only
   node scripts/db/bootstrap-supabase.mjs --target <env> --run
   node scripts/db/bootstrap-supabase.mjs --target <env> --run-extensions
   node scripts/db/migrate-supabase.mjs --target <env> --status
   node scripts/db/migrate-supabase.mjs --target <env> --deploy
   node scripts/db/migrate-supabase.mjs --target <env> --verify
   ```
   With `--target prod`, every write (`--run`, `--run-extensions`, `--deploy`, `--record-committed`) first asks whether a backup was taken, then for the first four characters of the production project ref. It refuses without an interactive terminal.
4. Private storage bucket in this project: [supabase-storage-setup.md](supabase-storage-setup.md).
5. Download the project's CA certificate (**Database Settings → SSL Configuration**) and copy it to that server as `/opt/crm/supabase-ca.crt`.

> **Open item before the first deploy:** `migrate-supabase.mjs` only runs migrations pinned in its reviewed list (0001–0008), and `verify-supabase.sql` checks for exactly those. Migrations 0009–0027 must be reviewed and pinned, and the verification updated, before `--deploy` will run. This is a separate, owner-approved step.

### 4.3 E-mail (Gmail)

Use a Gmail account made for this environment. Turn on 2-Step Verification and create an **App password** (Google Account → Security → App passwords). Values: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=<that address>`, `SMTP_PASSWORD=<16-letter app password>`, `EMAIL_FROM=CBR Property CRM <that address>`.
Later, SES with your own domain ([email-ses-setup.md](../architecture/email-ses-setup.md)) changes only these values.

### 4.4 Server configuration (secrets)

On the server, in `/opt/crm`, create these with `nano` from the `.example` files in `deploy/aws/`, then `chmod 600 *.env`:

| File | Contents |
|---|---|
| `deploy.conf` | `ECR_REGISTRY`, `SITE_DOMAIN` (`cbr-crm-qa.duckdns.org` or `cbr-crm.duckdns.org`) |
| `shared.env` | This environment's role URLs (`crm_app`, `crm_auth`, `crm_platform`), `BETTER_AUTH_URL` (`https://<SITE_DOMAIN>`), its own `BETTER_AUTH_SECRET`, Supabase storage, SMTP host and port |
| `worker.env` | Gmail address and app password, `CLEANUP_DATABASE_URL` |

Every database URL ends with `?sslmode=verify-full&sslrootcert=/run/crm/supabase-ca.crt`. The app refuses to start if a URL logs in as `postgres` or `crm_migrator`.

## 5. Everyday flow

```
1. PC          work on qa → pnpm test (local Docker DB) → git push
2. GitHub      ci runs on every push to qa (tests, lint, build)
3. Build       Actions → release → Run workflow on qa → note the SHA in the summary
4. QA          (migrations?) node scripts/db/migrate-supabase.mjs --target qa --deploy
               on cbr-qa: bash /opt/crm/deploy.sh <SHA> → test on cbr-crm-qa.duckdns.org
5. Production  only when QA is OK:
               a. git checkout main && git merge --ff-only qa && git push   (main = tested commit)
               b. (migrations?) back up prod (supabase-free-setup.md §8), then
                  node scripts/db/migrate-supabase.mjs --target prod --deploy
               c. on cbr-prod: bash /opt/crm/deploy.sh <same SHA>
               d. check https://cbr-crm.duckdns.org/api/health and sign in
```

- **Same SHA everywhere:** step 5c deploys the images built in step 3. Nothing is rebuilt for production.
- **`--ff-only`** keeps `main` exactly at the tested commit. If it fails, `main` has a commit that `qa` lacks: merge `main` into `qa`, test on QA again, then repeat.
- **Migrations must be backward-compatible** with the version currently running, because the database is updated a few minutes before the new app starts.
- **Rollback:** `bash /opt/crm/deploy.sh <previous SHA>` (it is in `/opt/crm/current-tag` before each deploy). It does not undo a migration; restore from the backup if that is needed.
- **Hotfix:** branch from `main`, fix, merge into `qa`, then follow steps 2–5 as normal.
- GitHub's free plan cannot protect `main` on a private repository. Production is still safe because nothing deploys to it automatically: a production deploy needs SSH into `cbr-prod`.

## 6. Checks after a deploy

- `https://<SITE_DOMAIN>/api/health` returns `{"status":"ok"}`.
- Sign up; the verification e-mail arrives.
- `docker compose logs worker` shows `importCommitStrategy: "set"` and no errors.
- On a phone (390 px), the everyday screens work.

## 7. Operating

- **Logs:** `cd /opt/crm && docker compose logs -f web worker` (rotated at 10 MB × 5).
- **Saving credits:** stop `cbr-qa` in the EC2 console when you aren't testing, and start it before step 4. The containers come back by themselves.
- **Memory:** `free -h`. If swap use stays high, change that server to `t3.small` (stop → change type → start).
- **Supabase pauses a project after 7 days without activity.** QA may pause when idle: restore it from the Supabase dashboard.
- **Backups (production):** nightly encrypted dumps (supabase-free-setup.md §8). Supabase Free keeps none.
- **SSH:** if your home IP changes, update both security groups' SSH rule.
- **Updates:** Ubuntu security updates install automatically; `sudo reboot` monthly when `/var/run/reboot-required` exists.

## 8. Before real customer data

Production holds synthetic data only until the gates in [staging-preparation.md](staging-preparation.md) §0 are met: real-route isolation passes on QA (G3), a restore drill with measured RPO (G4), and the legal review (G5).

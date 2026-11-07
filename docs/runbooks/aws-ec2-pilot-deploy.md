# Runbook: pilot deployment on one AWS EC2 host (Mumbai)

> **Status (2026-11-01): prepared, not executed.** Nothing has been created in AWS, GitHub or DNS. Decision record: [ADR-0024](../architecture/adr/ADR-0024-pilot-hosting-aws-ec2.md).
> **Secrets:** never in Git, chat or tickets. They live only in your password manager and in `/opt/crm/*.env` on the server.

## 1. What runs where

| Part | Where | Files |
|---|---|---|
| Web (Next.js), worker, Valkey, Caddy (HTTPS) | One EC2 instance, `ap-south-1`, Docker Compose | `deploy/aws/` |
| PostgreSQL, file storage | Supabase Free, **region Mumbai** | [supabase-free-setup.md](supabase-free-setup.md) |
| E-mail | Amazon SES `ap-south-1`, SMTP | [email-ses-setup.md](../architecture/email-ses-setup.md) |
| Image builds | GitHub Actions → Amazon ECR | `.github/workflows/release.yml` |

**You need:** an AWS account, and the code in a **private** GitHub repository.

### 1.1 Zero-cost start (owner, 2026-11-07)

| Item | Free choice for the start | Paid choice later |
|---|---|---|
| Server, disk, public IP, ECR | AWS free-plan credits (no bill while credits last) | Paid AWS plan |
| Web address + HTTPS | Free **DuckDNS** sub-domain, e.g. `cbr-crm.duckdns.org`; Caddy gets a free Let's Encrypt certificate | Own domain (~₹800–1,000/year) |
| E-mail (sign-up verification, invites, password reset) | **Gmail SMTP** with an app password (Gmail limit about 500 mails/day) | Amazon SES with your own domain |
| Code + builds | GitHub Free (private repo, 2,000 Actions minutes/month) | Same |
| Database + files | Supabase Free | Supabase Pro |

AWS still asks for a debit/credit card at sign-up (a small verification charge is refunded). Nothing is charged while you stay on the free plan.

## 2. AWS account (owner)

1. Sign up at aws.amazon.com. Choose the **free plan** (credits, about 6 months; read the terms shown at sign-up).
2. Secure the root user: MFA on, no access keys. Create an admin IAM Identity Center user for daily work.
3. **Billing → Budgets:** alerts at $5 and $20.
4. Select region **Asia Pacific (Mumbai) ap-south-1** for everything below.
5. **Before the free plan ends, upgrade to a paid plan.** A free-plan account that is not upgraded is closed, and its resources are deleted.

## 3. Domain and container registry

1. **Free start:** sign in at duckdns.org (with GitHub or Google) and add a sub-domain, e.g. `cbr-crm`. After step 5.3, put the Elastic IP in its *current ip* box and press *update ip*. The IP never changes, so no updater is needed. Use `cbr-crm.duckdns.org` wherever this guide says `<domain>`, and skip step 5.4.
   **Later:** buy a domain and point it at the same Elastic IP (step 5.4), then change `SITE_DOMAIN` and `BETTER_AUTH_URL` and redeploy.
2. **ECR → Create repository** twice, private: `cbr-crm-web` and `cbr-crm-worker`. Turn on **scan on push**.
3. On each repository, **Lifecycle policy**: keep the last 10 images:
   ```json
   { "rules": [{ "rulePriority": 1, "selection": { "tagStatus": "any", "countType": "imageCountMoreThan", "countNumber": 10 }, "action": { "type": "expire" } }] }
   ```

## 4. GitHub → AWS without stored keys (OIDC)

1. **IAM → Identity providers → Add provider:** OpenID Connect, URL `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`.
2. **IAM → Roles → Create role → Web identity**, that provider. Name it `cbr-crm-github-release`. Replace its trust policy with (fill in `<account-id>`, `<github-owner>/<repo>`):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": { "Federated": "arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com" },
       "Action": "sts:AssumeRoleWithWebIdentity",
       "Condition": {
         "StringEquals": {
           "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
           "token.actions.githubusercontent.com:sub": "repo:<github-owner>/<repo>:ref:refs/heads/main"
         }
       }
     }]
   }
   ```
3. Give it this inline policy (push to the two repositories only):
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
4. In GitHub: **Settings → Secrets and variables → Actions → Variables**: `AWS_RELEASE_ROLE_ARN` (the role's ARN) and `ECR_REGISTRY` (`<account-id>.dkr.ecr.ap-south-1.amazonaws.com`). These are not secrets.

## 5. The server

1. **IAM → Roles → Create role → AWS service → EC2**, managed policy `AmazonEC2ContainerRegistryReadOnly`. Name: `cbr-crm-ec2`.
2. **EC2 → Launch instance:**
   - Image: **Ubuntu Server 24.04 LTS (x86_64)**.
   - Type: **t3.micro** (marked *Free tier eligible*). The images are built for x86_64, so don't pick a `t4g`.
   - Key pair: create one (ED25519); keep the `.pem` outside the repository.
   - Security group: **SSH 22 from My IP only**; HTTP 80 and HTTPS 443 from anywhere.
   - Storage: 20 GiB gp3.
   - Advanced → IAM instance profile: `cbr-crm-ec2`. Metadata version: **V2 only**.
3. **Elastic IP:** allocate one and associate it with the instance (the address then survives restarts).
4. **DNS:** an `A` record for the site's domain → the Elastic IP.
5. From your PC (PowerShell, in the repository folder):
   ```powershell
   scp -i <key.pem> deploy/aws/compose.yml deploy/aws/Caddyfile deploy/aws/deploy.sh deploy/aws/server-setup.sh ubuntu@<elastic-ip>:~/
   ssh -i <key.pem> ubuntu@<elastic-ip>
   ```
6. On the server:
   ```sh
   bash ~/server-setup.sh
   mv ~/compose.yml ~/Caddyfile ~/deploy.sh /opt/crm/
   exit   # log in again so the docker group applies
   ```

## 6. Database, storage and e-mail (gated)

1. **Supabase pilot project in region Mumbai**, then roles, extensions and migrations exactly as [supabase-free-setup.md](supabase-free-setup.md) §3–§6. Each **APPROVAL** step there still needs the owner's go-ahead. Migrations always run from your PC with `scripts/db/migrate-supabase.mjs`, never from the server.
2. Private storage bucket: [supabase-storage-setup.md](supabase-storage-setup.md).
3. Download the project's CA certificate (**Database Settings → SSL Configuration**) and copy it to the server as `/opt/crm/supabase-ca.crt`.
4. **E-mail, free start (Gmail SMTP):** use a Gmail account made for the CRM (not a personal one). Turn on 2-Step Verification, then create an **App password** (Google Account → Security → App passwords). Settings: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=<that gmail address>`, `SMTP_PASSWORD=<the 16-letter app password>`, and `EMAIL_FROM=CBR Property CRM <that gmail address>` (Gmail rewrites any other From address). No code change: the app already sends through plain SMTP.
   **Later:** move to SES with your own domain ([email-ses-setup.md](../architecture/email-ses-setup.md) §2–§3): only the `SMTP_*` and `EMAIL_FROM` values change.

## 7. Server configuration (secrets)

On the server, in `/opt/crm`, create these files with `nano`, using the `.example` files in `deploy/aws/` as the template, then `chmod 600 *.env`:

| File | Contents |
|---|---|
| `deploy.conf` | `ECR_REGISTRY`, `SITE_DOMAIN` |
| `shared.env` | Role URLs (`crm_app`, `crm_auth`, `crm_platform`), `BETTER_AUTH_*`, Supabase storage, SMTP host and port |
| `worker.env` | SES SMTP user and password, `CLEANUP_DATABASE_URL` |

Every database URL ends with `?sslmode=verify-full&sslrootcert=/run/crm/supabase-ca.crt`. The app refuses to start if a URL logs in as `postgres` or `crm_migrator`.

## 8. Release and deploy

1. Push to `main` on GitHub and let `ci` pass.
2. **Actions → release → Run workflow** on `main`. The summary prints the tag (the commit SHA).
3. On the server: `cd /opt/crm && bash deploy.sh <sha>`. It pulls the images, starts everything and waits until the web health check passes. Caddy gets the HTTPS certificate on the first start (port 80 and DNS must already be right).
4. **Check:**
   - `https://<domain>/api/health` returns `{"status":"ok"}`.
   - Sign up; the verification e-mail arrives.
   - `docker compose logs worker` shows `importCommitStrategy: "set"` and no errors.
   - On a phone (390 px), the everyday screens work.

**When a release has migrations:** take a backup (supabase-free-setup.md §8), run `migrate-supabase.mjs --deploy` from your PC, then deploy.
**Rollback:** `bash deploy.sh <previous sha>` (the last one is in `/opt/crm/current-tag` before you deploy). A migration is not rolled back by this.

## 9. Operating the pilot

- **Logs:** `docker compose logs -f web worker` (rotated at 10 MB × 5).
- **Memory:** `free -h`. If swap use stays high, move to `t3.small` (stop instance → change type → start). Paid after the credits.
- **Supabase pauses after 7 days without activity.** Normal daily use prevents it.
- **Backups:** nightly encrypted dumps (supabase-free-setup.md §8). Supabase Free has none.
- **SSH:** if your home IP changes, update the security group's SSH rule.
- **Updates:** Ubuntu security updates install automatically; `sudo reboot` monthly when `/var/run/reboot-required` exists.

## 10. Before real customer data

Synthetic data only until the gates in [staging-preparation.md](staging-preparation.md) §0 are met: real-route isolation passes on this host (G3), a restore drill with measured RPO (G4), and the legal review (G5).

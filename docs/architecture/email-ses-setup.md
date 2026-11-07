# Production Email: Amazon SES (ap-south-1, Mumbai)

> **Decision (owner, 2026-10-20, item C):** Amazon SES in **ap-south-1** is the preferred production email provider. **Mailpit** stays the local development mail sink. Resolves OD-13.
> **Status:** not set up. No AWS account, domain or credential has been created, and nothing here has been purchased. This document lists what remains to be done before staging and production can send email.

## 1. How the application sends email (already built)

- **Path:** Web/auth code → BullMQ `email` queue (Valkey) → **worker** → `createSmtpSender()` (nodemailer, SMTP). See `src/platform/email/sender.ts` and `src/worker/handlers.ts`.
- **SES's SMTP interface** (`email-smtp.ap-south-1.amazonaws.com`, port **587** STARTTLS) works with this adapter **without code changes**. Only the `SMTP_*` and `EMAIL_FROM` environment variables differ per environment.
- **Retries (worker):**
  - 5 attempts with exponential backoff (5 s base).
  - Completed jobs are deleted at once and failed jobs after 24 h, because auth emails contain single-use links.
- **Failure handling (added 2026-10-20):**
  - SMTP **5xx** replies are **permanent**, for example SES `554 Message rejected` or an address on the suppression list. The job fails at once (`UnrecoverableError`) instead of retrying.
  - **4xx** replies, such as SES `454 Throttling` or a temporary local problem, and network errors are retried with backoff.
  - Logs contain only the reply code, never the address or the message.
  - Test: `tests/integration/worker-outbox.test.ts`.
- **Templates** are plain text + simple HTML, with no tracking pixels or click tracking.

## 2. Setup requirements (to do, in order)

| # | Requirement | Details | Owner / who |
|---|---|---|---|
| 1 | **AWS account** for CBR, root user secured | Root MFA; no root access keys; billing alerts (e.g. $5 and $20); region **ap-south-1** for SES | Owner creates the account; engineering configures |
| 2 | **Sending domain owned and chosen** | Use a **subdomain** for transactional mail, e.g. `mail.<cbr-domain>`, so its reputation is separate from staff mailboxes. The domain is not bought yet (cost estimate §1 item 10) | Owner |
| 3 | **Domain identity verified in SES** with **Easy DKIM (RSA 2048)** | SES issues 3 CNAME records; publish them in DNS. The identity shows *Verified* when they resolve | Engineering + DNS access |
| 4 | **SPF via a custom MAIL FROM domain** | e.g. `bounce.mail.<cbr-domain>`: an MX record to `feedback-smtp.ap-south-1.amazonses.com` and a TXT record `v=spf1 include:amazonses.com -all`. This aligns SPF with the From domain for DMARC | Engineering |
| 5 | **DMARC** | TXT `_dmarc.<cbr-domain>`: start with `v=DMARC1; p=none; rua=mailto:<reports-address>`. After 2–4 weeks of clean reports, move to `p=quarantine`, then `p=reject` | Owner chooses the report mailbox |
| 6 | **Restricted credentials** | See §3 | Engineering |
| 7 | **Leave the SES sandbox** (production access) | New SES accounts start in the **sandbox**: they can send only to verified addresses, with a low daily quota (typically 200/day) and 1 message/s. **Request production access** in the SES console for ap-south-1. Describe the use case: transactional only (invitations, verification, password reset, security alerts), opt-in recipients, how bounces and complaints are handled (§4), expected volume (~5,000/month). AWS reviews within about a day and may ask follow-up questions | Owner submits (account holder); engineering drafts the text |
| 8 | **Bounce and complaint processing** | See §4 | Engineering (small Phase-2-or-earlier task) |
| 9 | **Staging** keeps sending to Mailpit, or to SES with an allow-list of test addresses only | Staging must never email real customers | Engineering |
| 10 | **Monitoring** | CloudWatch alarms: bounce rate > 2% and complaint rate > 0.05%. SES pauses sending at 5% bounces or 0.1% complaints. Alert the operations email | Engineering |

## 3. Credentials (never in source control or browser-exposed variables)

- **Dedicated IAM user** for sending, e.g. `cbr-crm-ses-sender-prod`, with **only** this policy. Use one user per environment.
  ```json
  {
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": "ses:SendRawEmail",
      "Resource": "arn:aws:ses:ap-south-1:<account-id>:identity/mail.<cbr-domain>",
      "Condition": { "StringEquals": { "ses:FromAddress": "no-reply@mail.<cbr-domain>" } }
    }]
  }
  ```
- **SMTP password:** generate the SMTP credentials from that user's access key (SES console → SMTP settings). The derived password is region-specific.
- **Storage:**
  - Store `SMTP_USER` / `SMTP_PASSWORD` only as **encrypted environment variables** in the hosting platform (App Platform secrets). They go to the **worker** component only. The web component only enqueues and needs no SMTP credentials.
  - They are server-side variables. Never `NEXT_PUBLIC_*`, never in `.env.example`, never in logs (pino redaction covers `password`/`secret` keys).
- **Rotation:** every 90 days or on staff change. Create the new key, deploy, then delete the old key.
- **Never** use the root user or an administrator key for sending.

## 4. Bounces, complaints and suppression

- **Account-level suppression list:** keep SES's suppression list on, for both bounces and complaints. SES then refuses to send to addresses that hard-bounced or complained. The worker treats that refusal as a permanent failure (§1).
- **Event publishing:** a **configuration set** (`cbr-crm-prod`) with an event destination for `BOUNCE`, `COMPLAINT`, `REJECT` and `DELIVERY_DELAY` → **SNS topic → SQS queue**. The worker polls SQS, so no public webhook endpoint is needed.
- **Not built yet (planned):**
  - an SQS consumer in the worker. It needs the AWS SDK SQS client, a new dependency, so it is pinned and reviewed when it is added;
  - a per-user flag `email_undeliverable_at`;
  - an audit entry;
  - an admin-visible notice ("this user's email bounces"), so an Owner can correct an address.

  Until this exists, SES's suppression list prevents repeat sends, but nobody in the app is told. This is acceptable for the pilot's low volume, with a manual weekly check of the SES console.
- **Complaints** on transactional mail usually mean a mistyped or hostile address. Review each one.

## 5. Cost assumptions and pricing option

**Prices** come from the AWS price list API for ap-south-1, read 2026-10-20.

| Item | Price (USD) | Pilot volume | USD / month |
|---|---|---|---|
| Outbound email, **à la carte** | $0.10 per 1,000 recipients | ~5,000 | 0.50 |
| Outbound email, **Essentials plan** (no plan fee) | $0.16 per 1,000 messages | ~5,000 | 0.80 |
| Attachments | $0.12 per GB | none (we send no attachments) | 0 |
| Dedicated IP | $24.95/IP/month (standard) or $15 + per-email (managed) | **not needed** at this volume | 0 |
| Virtual Deliverability Manager | $0.07 per 1,000 | **not selected** | 0 |
| SNS + SQS for bounce events | free tier / cents | < 100 events | ~0 |

- **Selected option:**
  - shared IPs, no dedicated IP, no VDM;
  - the **Essentials plan**, which the SES pricing page says accounts start on by default (à la carte where the account offers it);
  - expected **≤ $1/month** (≈ ₹95) before GST. The difference between the two pricing options is under $0.50/month at pilot volume.
- **Free tier:** new AWS accounts receive Free Tier credits that cover this volume for months. The estimate ignores the credits.
- **Taxes:** AWS bills Indian customers through AWS India (Amazon Web Services India Pvt Ltd) **with 18% GST**.
- **Outside the ₹15,000 ceiling:** email is a variable third-party charge.

## 6. Configuration per environment

| Variable | Local | Staging | Production |
|---|---|---|---|
| `SMTP_HOST` | `127.0.0.1` (Mailpit) | Mailpit sidecar or SES | `email-smtp.ap-south-1.amazonaws.com` |
| `SMTP_PORT` | `51025` | — | `587` (STARTTLS) |
| `SMTP_USER` / `SMTP_PASSWORD` | unset | staging IAM SMTP credentials if SES | production IAM SMTP credentials (secret) |
| `EMAIL_FROM` | `CBR Property CRM <no-reply@cbr-crm.local>` | `… <no-reply@staging.mail.<domain>>` | `CBR Property CRM <no-reply@mail.<cbr-domain>>` |

**Before go-live:** send a test to a Gmail and an Outlook mailbox. Check SPF=pass, DKIM=pass and DMARC=pass in the headers, and check the links use the production `BETTER_AUTH_URL`.

## Sources (read 2026-10-20)

- SES pricing: https://aws.amazon.com/ses/pricing/
- AWS price list API, SES ap-south-1: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonSES/current/ap-south-1/index.csv
- SES sandbox and production access: https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html
- Easy DKIM: https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dkim-easy.html
- Custom MAIL FROM: https://docs.aws.amazon.com/ses/latest/dg/mail-from.html
- SMTP credentials: https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html
- Suppression list: https://docs.aws.amazon.com/ses/latest/dg/sending-email-suppression-list.html
- Event publishing: https://docs.aws.amazon.com/ses/latest/dg/monitor-using-event-publishing.html

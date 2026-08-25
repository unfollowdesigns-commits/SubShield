# SubShield — Build & Launch Spec (Zero-Cost Stack)

**Product:** Automated subcontractor Certificate of Insurance (COI) compliance engine.
**Market:** Commercial GCs, residential homebuilders, commercial property managers.
**Objective:** Replace manual COI tracking with an automated extraction → verification → chase pipeline.
**Target:** $1,000,000 ARR (250 clients @ $350/mo).

**Cost posture (the governing constraint):** the only recurring bills before revenue are two
domains (~$41/yr together) and an OpenAI API key measured in single-digit dollars per month.
Everything else runs on free tiers that explicitly permit commercial use. This document
is the original blueprint re-based on that constraint — the product is unchanged, the
$939/mo stack is not.

> **Verify prices before you commit.** Every figure below was current as of writing and
> every vendor moves them. Re-check each pricing page during Week 1 of the build.

---

## Table of Contents

1. [What Changed and Why](#1-what-changed-and-why)
2. [Phase 1: Stack & Architecture](#phase-1-stack--architecture)
3. [Phase 2: Database Schema (Postgres)](#phase-2-database-schema-postgres)
4. [Phase 3: Extraction Engine & Prompt](#phase-3-extraction-engine--prompt)
5. [Phase 4: Automation (Workers + Cron)](#phase-4-automation-workers--cron)
6. [Phase 5: Human-in-the-Loop Pipeline](#phase-5-human-in-the-loop-pipeline)
7. [Phase 6: Front-End Portals](#phase-6-front-end-portals)
8. [Phase 7: QA & Edge-Case Matrix](#phase-7-qa--edge-case-matrix)
9. [Phase 8: Go-to-Market Runbook](#phase-8-go-to-market-runbook)
10. [Phase 9: Onboarding, Retention & Financial Model](#phase-9-onboarding-retention--financial-model)
11. [Risks & Honest Caveats](#11-risks--honest-caveats)

---

## 1. What Changed and Why

The original blueprint's ~$939/mo stack was mostly paying for glue code and a spreadsheet
UI. Each line item is replaced by something free that does the same job, or cut.

| Original | Cost | Replacement | Cost | Why |
| :--- | :--- | :--- | :--- | :--- |
| Make.com Enterprise | $299/mo | **Cloudflare Workers** (free plan) | $0 | Same webhooks + cron, written as ~400 lines of TypeScript instead of drag-and-drop. Free plan allows commercial use. |
| Airtable Enterprise | $240/mo | **Supabase Postgres** (free) + a static dashboard | $0 | Airtable's free base caps at ~1,000 records and its per-seat pricing scales with your client count — exactly the wrong shape. |
| Postmark | $15/mo min | **Resend** free (3,000/mo, 100/day) or **Brevo** free (300/day) | $0 | Same transactional delivery. Postmark has no free tier. |
| Twilio SMS | usage | **Cut from v1** | $0 | Twilio has no free tier. SMS is the weakest link in the chase sequence anyway; add it later at ~$0.008/message once clients pay. |
| Fillout.com | $0–25/mo | **Static upload page** on the Worker | $0 | It's one file input and two hidden fields. |
| Inbound email parsing | paid on most vendors | **Cloudflare Email Routing + Email Workers** | $0 | Catch-all `*@process.yourdomain.com` routes straight into a Worker. This is the single best free component in the stack. |
| Claude 3.5 Sonnet / GPT-4o | ~$250/mo est. | **A current mini-tier OpenAI model** with Structured Outputs | ~$3–8/mo | The original estimate was ~100x too high for this workload. See [cost math](#api-cost-math). |
| Slack | free tier fine | Unchanged (incoming webhooks are free) | $0 | |
| — | — | **Domains** (product + outbound) | ~$41/yr | Unavoidable. `subshield.io` ~$30/yr, `subshieldhq.com` ~$11/yr. Compare registrars — Cloudflare Registrar sells at wholesale. |

**Total recurring before revenue: two domains plus an OpenAI key.** Realistically under
$10/month until you are past ~50 paying clients.

`subshield.com` was already registered by someone else when this was written, as were
`.co`, `.net`, `.app`, `getsubshield.com` and `trysubshield.com`. `subshield.io` is the
product domain throughout this document and `subshieldhq.com` is the outbound-sales
domain — re-check both before building anything around them.

### The one thing to not cheap out on

Do **not** run client insurance documents through a free LLM tier whose terms allow the
provider to train on submitted content. COI forms carry business names, addresses, policy
numbers and broker contacts. Use a paid API key (OpenAI's paid API does not train on API
inputs by default) even though a free Gemini/AI Studio key would technically work. This is
the one place where "free" costs you the ability to answer a client's security questionnaire.

---

## Phase 1: Stack & Architecture

```
[INCOMING CHANNELS]
    Subcontractor upload page          Dedicated inbound alias
   app.subshield.io/u/<token>      apex-certs@process.subshield.io
                │                                 │
                └────────────────┬────────────────┘
                                 ▼
                    [CLOUDFLARE WORKER: ingest]
              HTTP handler + email() handler, same code path
                                 │
                     ┌───────────┴───────────┐
                     ▼                       ▼
          [R2: raw document]       [D1/Postgres: certificates row, status=processing]
                                 │
                                 ▼
                    [EXTRACTION — OpenAI Structured Outputs]
                  mini-tier vision model, acord_extractor_v1.1
                                 │
                                 ▼
                    [DETERMINISTIC VALIDATION — pure TS]
                  Checks A–F, no model involvement in pass/fail
                                 │
                  ┌──────────────┴──────────────┐
                  ▼                             ▼
         [PASSED]                       [FAILED / LOW CONFIDENCE]
                  │                             │
                  ▼                             ▼
      status = auto_approved            status = pending_review
      sub → Compliant (Green)           → Slack webhook + review queue
                  │                             │
                  └──────────────┬──────────────┘
                                 ▼
                   [NOTIFY — Resend transactional email]
                                 │
                                 ▼
              [DAILY CRON WORKER — 08:00 chase ladder 30/15/7/0]
```

### Core technologies

| Layer | Choice | Free-tier reality |
| :--- | :--- | :--- |
| Compute / orchestration | Cloudflare Workers | 100k requests/day, up to 3 cron triggers per Worker, 50 subrequests per invocation. Commercial use permitted. |
| Inbound email | Cloudflare Email Routing → Email Workers | Free. 25 MiB max message size, 200 routing rules and 200 destination addresses per account. Use a **catch-all rule to one Worker** rather than one rule per client, or you hit the 200-rule ceiling at 200 clients. |
| Database | Supabase Postgres | 500 MB database, 5 GB egress, 2 active projects, **no backups**, paused after 7 days of inactivity (your daily cron prevents this). Commercial use permitted. |
| Document storage | Cloudflare R2 | 10 GB stored free, zero egress fees. Chosen over Supabase Storage (1 GB) because COIs accumulate — see [storage math](#storage-math). |
| Extraction | OpenAI API, mini-tier vision model, Structured Outputs (`strict: true`) | Paid, ~$0.001–0.002 per document. |
| Email delivery | Resend (free: 3,000/mo, 100/day) | Brevo's free 300/day is the better ceiling if daily volume, not monthly, is what binds you. |
| Dashboard | Static SPA on Cloudflare Pages, reading Postgres via the Worker API | Free, unlimited sites, unlimited bandwidth. |
| Alerts (HITL) | Slack incoming webhooks | Free. |
| Secrets | `wrangler secret put` | Free. |

### Storage math

A typical COI is a 1-page PDF at 100–400 KB; a phone photo can be 2–4 MB. Assume ~500 KB
average after you reject anything over 15 MB.

| Clients | Subs (~50 each) | Docs/yr (incl. renewals + rejects) | Storage/yr |
| ---: | ---: | ---: | ---: |
| 10 | 500 | ~1,000 | ~0.5 GB |
| 100 | 5,000 | ~10,000 | ~5 GB |
| 250 | 12,500 | ~25,000 | ~12.5 GB |

Supabase Storage's 1 GB free would break at roughly 20 clients. R2's 10 GB free carries you
to ~200 clients, and past that it is $0.015/GB-month — about $0.20/month for the overage at
full scale. Keep documents in R2 and only the `r2_key` in Postgres, and the 500 MB database
limit never becomes the binding constraint.

**Deliberately not used:** Vercel. Its Hobby plan prohibits commercial use — the day you
turn on Stripe you are in violation, and Pro is $20/mo. If you prefer the Next.js DX, budget
that $20 knowingly rather than discovering it via a suspension email.

---
## Phase 2: Database Schema (Postgres)

The four-table model from the original blueprint is sound; it just belongs in Postgres, not
Airtable. Run this as your initial migration.

```sql
-- ─── companies (your paying clients) ──────────────────────────────────────────
create table companies (
  id                        uuid primary key default gen_random_uuid(),
  company_name              text not null,
  primary_contact_name      text,
  primary_contact_email     text not null,
  inbound_alias             text unique not null,      -- apex-certs (local part only)
  min_gl_each_occurrence    bigint not null default 1000000,
  min_gl_aggregate          bigint not null default 2000000,
  require_additional_insured  boolean not null default true,
  require_waiver_subrogation  boolean not null default true,
  slack_webhook_url         text,                       -- null = fall back to email HITL
  status                    text not null default 'active'
                              check (status in ('active','paused','past_due')),
  created_at                timestamptz not null default now()
);

-- ─── subcontractors (your clients' vendors) ───────────────────────────────────
create table subcontractors (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references companies(id) on delete cascade,
  vendor_name      text not null,
  trade            text,
  contact_person   text,
  contact_email    text not null,
  contact_phone    text,
  upload_token     text unique not null,   -- unguessable; powers /u/<token>
  active_cert_id   uuid,                   -- FK added below (circular)
  last_chased_at   timestamptz,
  last_chase_stage int,                    -- 30 | 15 | 7 | 0, prevents double-sends
  created_at       timestamptz not null default now(),
  unique (company_id, contact_email)
);

-- ─── certificates (parsed documents) ──────────────────────────────────────────
create table certificates (
  id                      uuid primary key default gen_random_uuid(),
  subcontractor_id        uuid references subcontractors(id) on delete set null,
  company_id              uuid not null references companies(id) on delete cascade,
  r2_key                  text not null,          -- original PDF/scan in R2
  source                  text not null check (source in ('email','portal','manual')),
  producer_name           text,
  insured_entity_name     text,
  carrier_name            text,
  gl_policy_number        text,
  gl_each_occurrence      bigint,
  gl_general_aggregate    bigint,
  expiration_date         date,
  additional_insured      boolean,
  waiver_subrogation      boolean,
  certificate_holder_text text,
  ai_confidence           numeric(3,2),
  verification_status     text not null default 'processing'
                            check (verification_status in
                              ('processing','auto_approved','pending_review',
                               'rejected','expired','superseded')),
  failure_reasons         text[],                 -- ['limit_below_minimum', ...]
  raw_json_response       jsonb,
  model_used              text,
  extraction_cost_usd     numeric(8,5),
  created_at              timestamptz not null default now(),
  reviewed_by             text,
  reviewed_at             timestamptz
);

alter table subcontractors
  add constraint fk_active_cert
  foreign key (active_cert_id) references certificates(id) on delete set null;

-- ─── audit_logs (the thing that actually sells the product) ───────────────────
create table audit_logs (
  id              bigserial primary key,
  company_id      uuid references companies(id) on delete cascade,
  certificate_id  uuid references certificates(id) on delete set null,
  subcontractor_id uuid references subcontractors(id) on delete set null,
  action          text not null,   -- ingested|extracted|approved|rejected|
                                   -- chase_sent|status_changed|override
  actor           text not null default 'system',
  details         jsonb,
  created_at      timestamptz not null default now()
);

create index on certificates (company_id, verification_status);
create index on certificates (expiration_date);
create index on subcontractors (company_id);
create index on audit_logs (company_id, created_at desc);
```

### Compliance status is derived, never stored

The original spec kept a status field on the subcontractor. Don't — it drifts. Compute it:

```sql
create view v_subcontractor_status as
select
  s.id, s.company_id, s.vendor_name, s.contact_email, s.trade,
  c.expiration_date,
  case
    when c.id is null                                     then 'missing'
    when c.expiration_date < current_date                 then 'expired'
    when c.expiration_date <= current_date + 30           then 'expiring_soon'
    else 'compliant'
  end as compliance_status,
  c.expiration_date - current_date as days_remaining
from subcontractors s
left join certificates c
  on c.id = s.active_cert_id and c.verification_status = 'auto_approved';
```

The dashboard's green/yellow/red grid is `select * from v_subcontractor_status`. The chase
cron's work queue is the same view filtered on `days_remaining in (30,15,7)` or `< 0`.

### Retention

`raw_json_response` is a debug trace, not a record. Null it out after 90 days
(`update certificates set raw_json_response = null where created_at < now() - interval '90 days'`)
in the same nightly job — it's the only column that will meaningfully grow your 500 MB.

---
## Phase 3: Extraction Engine & Prompt

### System prompt (`acord_extractor_v1.1`)

Two changes from v1.0: an explicit document-type classifier (so TC-06 fails at the model,
not at a downstream heuristic) and a rule against inferring the coverage flags.

```text
You are an insurance compliance extraction engine specializing in ACORD 25
(Certificate of Liability Insurance) forms.

Analyze the provided document and return a single JSON object matching the schema.

STEP 0 — CLASSIFY:
Set "document_type" to "acord_25" only if this is a Certificate of Liability
Insurance. Otherwise set "other" and return nulls for every extracted field.
Do not attempt extraction from W-9s, invoices, quotes, policy declarations
pages, or endorsement forms.

STEP 1 — EXTRACT (ACORD 25 only):
Locate the "COMMERCIAL GENERAL LIABILITY" row of the coverage table. Extract:
  - "EACH OCCURRENCE" limit
  - "GENERAL AGGREGATE" limit
  - the policy number on that row
  - "POLICY EXP (MM/DD/YYYY)" on that row
Take these from the General Liability row ONLY. Do not read limits from the
Automobile, Umbrella, or Workers Compensation rows.

STEP 2 — COVERAGE FLAGS:
In the "ADDL INSD" and "SUBR WVD" columns, on the General Liability row only:
mark true if that cell contains Y, X, or a check; false if it is blank or N.
Never infer these flags from the DESCRIPTION OF OPERATIONS text, from an
attached endorsement, or from what would be typical. The columns are the
only evidence.

STEP 3 — HOLDER:
Extract the complete raw text of the CERTIFICATE HOLDER box, newlines intact.

STEP 4 — CONFIDENCE:
Score 0.00–1.00 on legibility, completeness, and absence of ambiguity.
Score below 0.90 if any required field was hard to read, if the form is
rotated or cropped, or if handwriting is involved.

RULES:
- Any value you cannot read: null. Never guess.
- Dates as YYYY-MM-DD.
- Limits as integers, no "$" and no commas. "1,000,000" -> 1000000.
- Output only the JSON object.
```

### Structured Output schema

```json
{
  "name": "acord_25_extraction",
  "strict": true,
  "schema": {
    "type": "object",
    "properties": {
      "document_type":       { "type": "string", "enum": ["acord_25", "other"] },
      "producer_name":       { "type": ["string", "null"] },
      "insured_entity_name": { "type": ["string", "null"] },
      "carrier_name":        { "type": ["string", "null"] },
      "gl_policy_number":    { "type": ["string", "null"] },
      "gl_each_occurrence_limit":   { "type": ["integer", "null"] },
      "gl_general_aggregate_limit": { "type": ["integer", "null"] },
      "gl_expiration_date":  { "type": ["string", "null"],
                               "description": "YYYY-MM-DD" },
      "additional_insured_included":    { "type": ["boolean", "null"] },
      "waiver_of_subrogation_included": { "type": ["boolean", "null"] },
      "certificate_holder_text": { "type": ["string", "null"] },
      "confidence_score":    { "type": "number" }
    },
    "required": [
      "document_type", "producer_name", "insured_entity_name", "carrier_name",
      "gl_policy_number", "gl_each_occurrence_limit", "gl_general_aggregate_limit",
      "gl_expiration_date", "additional_insured_included",
      "waiver_of_subrogation_included", "certificate_holder_text", "confidence_score"
    ],
    "additionalProperties": false
  }
}
```

> **`strict: true` requires every property to be listed in `required`.** Nullability is
> expressed with `["string","null"]`, not by omission. The original spec's six-item
> `required` list would be rejected by the API. Dates are nullable here too — a
> non-nullable date with a regex pattern forces the model to invent one when the field
> is illegible, which is exactly the hallucination the prompt forbids.

### Deterministic validation

The model extracts. It never decides. Pass/fail is this pure function, unit-testable
without an API key:

```ts
type Extraction = { /* the schema above */ };
type Company = {
  min_gl_each_occurrence: number; min_gl_aggregate: number;
  require_additional_insured: boolean; require_waiver_subrogation: boolean;
};

const CONFIDENCE_FLOOR = 0.90;

export function validate(x: Extraction, co: Company, today = new Date()): string[] {
  const fail: string[] = [];

  // A — right document at all
  if (x.document_type !== 'acord_25') return ['not_an_acord_25'];

  // B — extraction quality
  if (x.confidence_score < CONFIDENCE_FLOOR) fail.push('low_confidence');

  // C — required fields present
  if (!x.gl_expiration_date)          fail.push('missing_expiration_date');
  if (x.gl_each_occurrence_limit == null) fail.push('missing_occurrence_limit');

  // D — not expired
  if (x.gl_expiration_date) {
    const exp = new Date(`${x.gl_expiration_date}T23:59:59Z`);
    if (Number.isNaN(exp.getTime()))  fail.push('unparseable_expiration_date');
    else if (exp < today)             fail.push('policy_expired');
  }

  // E — limits meet this client's minimums
  if (x.gl_each_occurrence_limit != null &&
      x.gl_each_occurrence_limit < co.min_gl_each_occurrence)
    fail.push('occurrence_limit_below_minimum');
  if (x.gl_general_aggregate_limit != null &&
      x.gl_general_aggregate_limit < co.min_gl_aggregate)
    fail.push('aggregate_limit_below_minimum');
  if (x.gl_general_aggregate_limit == null && co.min_gl_aggregate > 0)
    fail.push('missing_aggregate_limit');

  // F — endorsements this client requires
  if (co.require_additional_insured && x.additional_insured_included !== true)
    fail.push('missing_additional_insured');
  if (co.require_waiver_subrogation && x.waiver_of_subrogation_included !== true)
    fail.push('missing_waiver_of_subrogation');

  return fail;                       // empty array = auto-approve
}
```

Two rules that keep you out of trouble:

1. **An empty `fail` array is the only path to `auto_approved`.** No model output, no
   confidence score, no "it's probably fine" heuristic can shortcut it.
2. **Every failure reason is a machine-readable slug**, because the chase email templates
   and the Slack alert both render from these slugs. Never store a prose reason.

### API cost math

Per document: one page image (~1,000–2,500 input tokens depending on detail setting) plus
a ~400-token prompt, returning ~250 output tokens. At mini-tier pricing in the range of
$0.25/1M input and $2.00/1M output, that is roughly **$0.0015 per certificate**.

| Volume | Extractions/mo | API cost/mo |
| :--- | ---: | ---: |
| 10 clients | ~120 | ~$0.20 |
| 100 clients | ~1,200 | ~$2 |
| 250 clients | ~3,000 | ~$5 |

Add re-extractions and failed uploads and call it **under $10/month at full scale**. The
original spec's $250/mo line item was off by roughly 30x. Cut it further if needed by
sending `detail: "low"` for first-pass classification and only re-running at high detail
when confidence lands under the floor.

**Guardrails worth having on day one:** set a hard monthly spend cap in the OpenAI
dashboard, and refuse files over 15 MB or with more than 4 pages before you ever call the
API. An accidental loop against a paid API is the only way this stack generates a surprise
bill.

---
## Phase 4: Automation (Workers + Cron)

Three entrypoints, one Worker, one `wrangler.toml`.

```toml
name = "subshield"
main = "src/index.ts"
compatibility_date = "2026-01-01"

[[r2_buckets]]
binding = "DOCS"
bucket_name = "subshield-docs"

[triggers]
crons = ["0 13 * * *"]     # 08:00 America/New_York; Workers cron is UTC only

[vars]
APP_URL = "https://app.subshield.io"
# secrets: OPENAI_API_KEY, RESEND_API_KEY, DATABASE_URL  (wrangler secret put)
```

```ts
export default {
  fetch:     handleHttp,        // portal uploads + dashboard API + Slack actions
  email:     handleInboundMail, // Cloudflare Email Routing catch-all
  scheduled: handleDailyCron,   // the 30/15/7/0 chase ladder
};
```

### Scenario A — intake & validation

```
handleInboundMail(message) OR POST /u/<upload_token>
  │
  ├─ 1. Resolve tenant.
  │      email:  local part of To: → companies.inbound_alias
  │      portal: upload_token → subcontractors → company
  │      No match → bounce with a plain-English reason. Never 500 silently.
  │
  ├─ 2. Guard the file.
  │      MIME in (application/pdf, image/jpeg, image/png)
  │      size <= 15 MB, pages <= 4
  │      Fail → rejection email to sender, audit_logs row, stop. No API call.
  │
  ├─ 3. Put the original in R2 → r2_key. Insert certificates row (processing).
  │
  ├─ 4. Extract: OpenAI Structured Outputs, acord_extractor_v1.1.
  │      Retry once on 429/5xx with 2s backoff, then fail to pending_review.
  │      Never retry a successful parse — you pay twice for the same answer.
  │
  ├─ 5. validate(extraction, company) → string[]
  │
  └─ 6. Switch:
         fail.length === 0
           → certificates.verification_status = 'auto_approved'
           → previous active cert = 'superseded'
           → subcontractors.active_cert_id = this cert
           → confirmation email to sub, cc client contact
           → audit_logs: approved
         fail.length > 0
           → verification_status = 'pending_review'
           → failure_reasons = fail
           → Scenario C (HITL alert)
           → audit_logs: pending_review + reasons
```

Matching an inbound email to a **subcontractor** (not just a company) is the one genuinely
fuzzy step. Order of evidence: sender address matches `subcontractors.contact_email` →
`insured_entity_name` fuzzy-matches `vendor_name` (trigram similarity > 0.6) → otherwise
leave `subcontractor_id` null and put it in the review queue as `unmatched_vendor`. Do not
guess. A COI filed against the wrong sub is worse than one sitting in a queue.

### Scenario B — the daily chase cron

```
scheduled(08:00 client-local, one UTC cron per timezone bucket if needed)
  │
  ├─ select * from v_subcontractor_status
  │    where company is active
  │      and (days_remaining in (30,15,7) or days_remaining < 0
  │           or compliance_status = 'missing')
  │
  ├─ skip rows where last_chase_stage already equals this stage
  │    (idempotency: the cron must be safe to run twice)
  │
  ├─ 30 days  → Email #1, friendly, direct upload link
  ├─ 15 days  → Email #2, follow-up, cc nobody
  ├─  7 days  → Email #3, urgent, cc the client's PM
  └─  0/past  → mark expired
                 lockout notice to sub
                 red-alert email to the client's site super
  │
  ├─ update last_chased_at, last_chase_stage
  ├─ audit_logs: chase_sent (this is the record that proves you notified them)
  └─ nightly housekeeping in the same invocation:
       null raw_json_response older than 90 days
       pg_dump → R2 (see Backups)
```

Two implementation notes the free tier forces on you:

- **Free-plan Workers cap subrequests at 50 per invocation.** A cron that emails 200 subs
  in one pass will die at #50. Batch: select the day's queue, process 40, write a cursor,
  and let a `waitUntil` chain or the next minute's trigger continue. Or hold the queue in
  a table and drain it 40 rows per run across three cron triggers.
- **Email is your real ceiling, not compute.** Resend's free tier is 100/day. At ~50 subs
  per client and four chase touches per sub per year, you send roughly
  `clients × 50 × 4 / 365` emails a day — about 55/day at 100 clients, 140/day at 250.
  So: free until ~80 clients, then $20/mo for the paid tier. Brevo's 300/day free tier
  pushes that ceiling out further if you'd rather stay at zero longer.

---

## Phase 5: Human-in-the-Loop Pipeline

No ambiguous extraction is ever auto-committed. That is a design rule, not a marketing
claim — see the caveat in §11 about how you describe it in sales copy.

```
[validate() returned a non-empty array]
              │
              ▼
[POST to the client's Slack incoming webhook — free]

  ⚠️  COMPLIANCE EXCEPTION — ABC Masonry LLC
  General aggregate is $1,000,000 (Apex Builders requires $2,000,000)
  Confidence 0.94 · GL exp 2027-03-14 · received via apex-certs@ 2 min ago
  [ View document ]  [ Approve override ]  [ Reject & request corrected COI ]
              │
              ▼
[Review queue at app.subshield.io/review/<cert_id>]
  Left:  the original PDF, inline
  Right: the extracted fields, editable, each failed check flagged in red
  Actions: Approve (with edits) · Approve override (records who and why) · Reject
              │
              ▼
[Every action writes audit_logs with actor = the reviewer's email]
```

Build notes:

- The Slack buttons are signed URLs into the same Worker (`?t=<hmac>`), not Slack
  interactive components — no Slack app review, no OAuth, no cost.
- **An override is not an approval.** Store `action = 'override'` with the reviewer and a
  required free-text reason. When a client's insurer asks why a sub with a $1M aggregate
  was on site, the audit log is the entire product.
- Clients without Slack get the same alert as an email with the same three links. Don't
  make Slack a requirement — most 15-person GC offices don't have it.

---

## Phase 6: Front-End Portals

### 1. Subcontractor upload page

`app.subshield.io/u/<upload_token>` — one static HTML file served by the Worker.

- Vendor name and email pre-filled from the token, read-only.
- Drag-and-drop, accepts `.pdf .png .jpg`, 15 MB cap enforced client- and server-side.
- On submit: immediate "received, checking now" state, then a live result within ~20s
  (poll `/u/<token>/status`). Telling a sub *instantly* that their aggregate is short is
  the feature that makes them re-upload the same day instead of next month.
- **Tokens are the auth.** Long, random, revocable per sub. No passwords, no accounts —
  subcontractors will not create accounts, and every product that made them try has failed.

### 2. Client operations dashboard

Static SPA on Cloudflare Pages, all data through the Worker API, magic-link sign-in via a
signed emailed token (30-minute expiry, sets a session cookie).

- **View 1 — Compliance grid.** Every active vendor, green/yellow/red, sortable by days
  remaining. This is the screen you demo.
- **View 2 — Exception queue.** Only rows needing human eyes, with the failed checks named.
- **View 3 — Audit report.** One button, generates a dated PDF of every vendor's status,
  active policy details and the full chase history. This is what they hand a bank or an
  insurance auditor, and it's the single strongest retention feature in the product.

Keep the whole front end under ~50 KB of hand-written JS. There is no framework in this
product's critical path, and a build step you don't have is a build step that can't break.

---
## Phase 7: QA & Edge-Case Matrix

Run every case against a seeded test tenant before the first paying client. Cases TC-01
through TC-06 are the original matrix; TC-07 onward are the failures that actually happen
in production and that the original spec didn't cover.

| # | Test input | Expected behavior | Covered by |
| :--- | :--- | :--- | :--- |
| TC-01 | Pristine digital ACORD 25 PDF | Auto-approved < 30s, sub turns green | needs a real document |
| TC-02 | Phone photo of a crumpled ACORD 25 | Parsed, confidence >= 0.90, auto-approved | needs a real document |
| TC-03 | Policy expired yesterday | `policy_expired`, rejected, chase triggered | `validate` · automated |
| TC-04 | $500k occurrence vs $1M minimum | `occurrence_limit_below_minimum`, HITL queue | `validate` · automated |
| TC-05 | ADDL INSD column blank | `missing_additional_insured`, correction request sent | `validate` · automated |
| TC-06 | A W-9 or an invoice | `not_an_acord_25`, rejection email, **no extraction charge** | `validate` · automated |
| TC-07 | ACORD 25 where the **Auto** row has $1M but GL is blank | `missing_occurrence_limit` — model must not borrow the auto limit | `validate` · automated |
| TC-08 | Multi-page PDF, ACORD on page 3 | Found, or cleanly rejected with "certificate not on first pages" | needs a real document |
| TC-09 | Upside-down / 90°-rotated scan | Parsed correctly, or confidence drops below floor → HITL | needs a real document |
| TC-10 | Certificate holder is a *different* GC | Flagged `holder_mismatch` for review, never auto-approved | `holderMatches` · automated |
| TC-11 | Same COI emailed twice in 5 minutes | One certificate row, second logged as duplicate, one email sent | `ingest` · automated |
| TC-12 | Sub emails from an address not on file | `unmatched_vendor` in review queue, nothing auto-assigned | `matchSubcontractor` · automated |
| TC-13 | 40 MB scan | Rejected before the API call, friendly "please send under 15 MB" | `checkFile` · automated |
| TC-14 | Password-protected PDF | Rejected with a specific reason, no crash, no charge | `isEncryptedPdf` · automated |
| TC-15 | OpenAI returns 429 | One retry, then `pending_review` with `extraction_failed` — never lost | `extract` · automated |
| TC-16 | Cron runs twice in one day | Zero duplicate chase emails (`last_chase_stage` guard) | `alreadyChased` · automated |
| TC-17 | Cron queue of 200 subs on the free plan | All 200 processed across batches, none dropped at the 50-subrequest cap | needs a seeded queue |
| TC-18 | Client A's token requesting Client B's data | 403, and an `audit_logs` entry. Test this one twice. | `signLink` · automated |

TC-18 is not optional. Multi-tenant leakage in a compliance product is the failure that
ends the company; every query in the Worker must be scoped by `company_id` derived from
the session, never from a request parameter.

---

## Phase 8: Go-to-Market Runbook

### ICP

- **Role:** Operations Director, VP of Construction, CFO, Office Manager.
- **Size:** 15–150 employees, $5M–$50M revenue.
- **Segments:** Commercial GCs, civil contractors, property management companies.
- **Buying trigger:** a recent audit, a denied claim, a renewal questionnaire, or an office
  manager who just quit. Ask about all four on the call.

### Cold email sequence

Send cold outreach from `subshieldhq.com`, never from `subshield.io`. Keeping the sales
domain separate from the product domain means cold-outreach reputation can never take down
your compliance-critical transactional email — which is the email that actually has to
arrive. At ~$11/yr it is the best-spent money in the plan.

Warm the outbound domain for two weeks before volume, cap at 30–50 sends/day per mailbox,
and follow CAN-SPAM: real physical address, working one-click unsubscribe, honest subject
lines.

**Email 1 — the operational audit (Day 1)**
> **Subject:** Quick question re: [Company]'s subcontractor insurance files
>
> Hi [First name],
>
> Who on your ops team currently spends Friday afternoons checking ACORD 25s and chasing
> subs for renewed certificates?
>
> If a sub steps onto an active site with a lapsed policy, [Company] carries the liability
> exposure when something goes wrong.
>
> We built SubShield for regional GCs: it reads incoming ACORD forms, checks the limits
> and endorsements against your requirements, and chases your subs starting 30 days before
> expiration.
>
> Open to a 5-minute walkthrough?

**Email 2 — the concrete offer (Day 4)**
> **Subject:** 60-second walkthrough: [Company] compliance portal
>
> Hi [First name],
>
> Most GCs we talk to are tracking 30–100 subs in a spreadsheet and an email folder. When
> we do the first import, there are almost always a handful of vendors carrying expired or
> deficient coverage that nobody in the office knew about.
>
> Send me 3 redacted ACORDs and I'll send back a live dashboard of your actual position
> within a few hours: [demo drop link]
>
> No software for your team to learn — they just stop doing the data entry.

**Email 3 — the close-out (Day 8)**
> **Subject:** Closing the loop on subcontractor tracking
>
> Hi [First name],
>
> I'll assume compliance tracking is handled on your end. If it ever becomes a bottleneck
> — a quarterly audit, an insurer questionnaire, someone leaving the office — reach back
> out and I'll set it up in a day.

Note on Email 2: the original draft claimed "on average 14% of their vendors had expired
coverage." Don't cite a statistic you haven't measured. "There are almost always a few" is
both true and more credible, and once you've run 20 imports you can replace it with your
own real number.

### Channel partners: commercial insurance brokers

The highest-leverage free channel. Search LinkedIn for "Commercial Insurance Producer" and
"Construction Insurance Specialist" in your metro; connect with ~20/week.

> "We run automated COI compliance for GCs — it makes sure your contractor clients never
> have a sub lapse, which is what turns into a denied claim and an ugly audit. Happy to
> offer it to your GC book at a partner rate, or pay your agency 20% recurring on referrals."

Confirm the referral fee is permissible under that broker's state licensing rules before
you put it in writing — some states restrict what licensed producers can accept.

### Free prospecting stack

Apollo free tier or manual LinkedIn + state contractor license lookups (public, free, and
better-targeted than any list you'd buy), Google Sheets for the pipeline, and your own
Resend account for sending. Budget $0. Do not buy a $99/mo sales-engagement tool before
client #10.

---

## Phase 9: Onboarding, Retention & Financial Model

### The 24-hour deployment checklist

```
[Day 0 — contract signed]
  1. insert into companies (name, contact, minimums, endorsement requirements)
  2. provision inbound alias: <client>-certs@process.subshield.io
     (catch-all Worker route — no per-client DNS or routing rule)
  3. generate per-sub upload tokens
  4. request their current subcontractor list (name, email, trade)
  5. bulk import → subcontractors
  6. send the baseline request to every sub with no active COI
  7. brand the upload page with their logo (one CSS variable + an <img> src)

[Day 1 — go live]
  - magic-link dashboard access to the office manager and ops VP
  - 15-minute screen share: the grid, the chase ladder, the audit report
  - set expectations: exceptions land in Slack or their inbox; someone must
    action them. The system does not remove judgment, it removes data entry.
```

The single highest-value onboarding step is #4–#6. The baseline import is where the client
discovers three expired vendors they didn't know about, and that discovery is what makes
the first invoice feel cheap.

### Real operating costs

| Item | 10 clients | 100 clients | 250 clients |
| :--- | ---: | ---: | ---: |
| Cloudflare Workers / Pages / R2 / Email | $0 | $0 | $0 (or $5 Workers Paid for headroom) |
| Supabase Postgres | $0 | $0 | $0–25 (Pro if you exceed 500 MB or want backups) |
| OpenAI API | ~$0.20 | ~$2 | ~$5 |
| Email delivery | $0 | $0–20 | $20 |
| Domains (2, amortized) | $3.50 | $3.50 | $3.50 |
| **Total / month** | **~$4** | **~$7–27** | **~$34–54** |

Versus $939/mo in the original plan. At 250 clients the stack is roughly **0.05% of
revenue**. The honest framing is not "98.9% gross margin" — it's that infrastructure was
never the cost in this business. Your real costs are your time on HITL review, support,
and onboarding imports, and those scale with client count no matter what you host on.

### Scale trajectory

| Stage | Clients | MRR | ARR | Notes |
| :--- | ---: | ---: | ---: | :--- |
| Month 1–3 | 10 | $3,500 | $42,000 | Everything free. You do HITL review yourself. |
| Month 4–6 | 35 | $12,250 | $147,000 | Still free. Email tier starts getting close. |
| Month 7–12 | 100 | $35,000 | $420,000 | First real bill: ~$20 email. Add Supabase Pro for backups. |
| Month 13–24 | 250 | $87,500 | $1,050,000 | ~$50/mo infra. First HITL hire well before here. |

Pricing: $350/mo per client, unlimited subcontractors, plus a $500 one-time onboarding and
data migration fee. Keep the onboarding fee — it filters tire-kickers and pays for the
messiest part of the work.

**The number that actually decides this business** is not infrastructure cost, it's
exceptions per client per week. If 10% of certificates need human review and a client
submits 20/month, that's ~2 reviews per client per month — about 10 minutes. At 250
clients that's ~40 hours/month, one part-time reviewer. Track it from client #1: it's your
only real variable cost and the only thing that determines when you need to hire.

### Backups (do this in week one)

The Supabase free tier has **no backups**. For a compliance product, that is the one free-tier
limitation you cannot simply accept. Mitigation, at $0: a nightly `pg_dump` in the same
cron (or a scheduled GitHub Action) writing a gzipped dump to R2 with 30-day retention.
Document originals already live in R2, which is separately durable. Test a restore once
before you have clients, and once after client #10.

---

## 11. Risks & Honest Caveats

1. **Free tiers move.** Every limit in this document is a snapshot. Cloudflare, Supabase
   and Resend can and do change free-plan terms. None of these choices are hard to migrate
   away from (Postgres is Postgres, Workers are ~400 lines), but do not build anything that
   depends on a specific free ceiling holding forever.
2. **"100% legal reliability" is not a claim you can make.** The original draft said it.
   Delete it from any sales asset. What you can truthfully say: no certificate is approved
   unless it passes deterministic checks against the client's stated requirements, every
   decision is logged with a timestamp and an actor, and anything ambiguous is escalated to
   a human before it is committed. That's stronger *because* it's verifiable.
3. **You are selling into a liability workflow.** You are not an insurance producer and you
   are not giving coverage advice — your contract should say so explicitly, disclaim
   determination of coverage adequacy, and cap liability. Get an actual attorney to write
   the MSA before client #1, and price E&O insurance early. This is the one line item worth
   spending real money on, and it will cost more than your entire tech stack.
4. **Extraction accuracy is a range, not a number.** Clean digital ACORDs parse near
   perfectly; a phone photo of a fax of a scan does not. The confidence floor plus HITL is
   what makes that acceptable. Measure your true auto-approval rate over the first 200
   documents before you promise anyone "fully automated."
5. **Email deliverability is the fragile part.** Compliance emails that land in spam are
   worse than no product. Set SPF, DKIM and DMARC on day one, keep outbound sales on a
   separate domain, and monitor bounces. No provider "ensures 99.9% inbox placement" — the
   original spec's claim about Postmark is marketing copy, not a guarantee anyone offers.
6. **The 50-subrequest cap and the 100-email/day cap are the two free-tier walls you will
   actually hit** — both around 80–100 clients, both solved for $5–20/mo. Plan the batching
   architecture now (Phase 4) so hitting them is a billing decision, not a rewrite.
7. **Cutting SMS is a real product change.** The original plan's 15- and 7-day SMS nudges
   are genuinely effective with subcontractors who live on their phones. It's cut here
   because Twilio has no free tier, not because it's a bad idea. Add it at ~$0.008/message
   once you have revenue — roughly $8/mo at 1,000 messages.

---

## Appendix: Pricing sources to re-verify

Figures in this document were checked against the following at time of writing. Re-verify
each before you commit to the stack — free-tier terms are the fastest-moving numbers in
this plan.

- Cloudflare Workers limits & pricing — `developers.cloudflare.com/workers/platform/limits/`
- Cloudflare Email Routing limits (25 MiB messages, 200 rules/destinations) — `developers.cloudflare.com/email-routing/limits/`
- Cloudflare R2 pricing — `developers.cloudflare.com/r2/pricing/`
- Supabase pricing & free-plan limits (500 MB DB, 1 GB storage, 7-day inactivity pause, no backups) — `supabase.com/pricing`
- Supabase billing FAQ / commercial use on Free — `supabase.com/docs/guides/platform/billing-faq`
- Resend quotas (3,000/mo, 100/day) — `resend.com/docs/knowledge-base/account-quotas-and-limits`
- Brevo free plan (300 emails/day) — `brevo.com/pricing`
- Vercel Hobby non-commercial restriction — `vercel.com/docs/limits` and Vercel's Terms of Service
- OpenAI API pricing — `openai.com/api/pricing`
- Twilio SMS pricing (for the deferred SMS ladder) — `twilio.com/sms/pricing`

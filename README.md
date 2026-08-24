# SubShield

Automated subcontractor Certificate of Insurance (COI) compliance for general
contractors, homebuilders and property managers.

A subcontractor's COI arrives — by email or through an upload link. It gets read,
checked against that client's actual insurance requirements, and either filed as
compliant or escalated to a human. Thirty days before it expires, the subcontractor
starts getting chased automatically. Every decision along the way is logged, because
the audit trail is what the client is really buying.

## Where things stand

The intake path is built and tested: a subcontractor opens their upload link,
drops in an ACORD 25, and gets an answer on the page in about twenty seconds —
approved, or a list of what is wrong with it in words they can take to their agent.

Not built yet: inbound email, the daily chase ladder, the client dashboard, the
HITL review queue. The full plan for all of it is in
**[BUILD_AND_LAUNCH_SPEC.md](BUILD_AND_LAUNCH_SPEC.md)**.

```
src/
  validate.ts     the only thing that decides compliant / not. Pure, 23 tests.
  extract.ts      OpenAI structured output, file guards, retry, cost metering
  prompt.ts       acord_extractor_v1.1 and its strict JSON schema
  db.ts           Supabase over PostgREST — no driver, no connection pooling
  upload-page.ts  the subcontractor's entire experience, one page
  index.ts        Worker entry: upload, status polling, audit logging
db/001_init.sql   schema, the derived-status view, RLS locked to the Worker
```

## The rule that matters

The model extracts. `validate()` decides. It is pure, synchronous and covered by
tests that run without an API key, so no future change can quietly let a model's
opinion become an approval. An empty array of failures — and nothing else — is
the only path to `auto_approved`.

Everything fails closed. An endorsement column the model could not read is not a
checked box. A confidence score of `NaN` is not a passing score. A document that
fails extraction lands in the review queue, never in the bin.

## Running it

```bash
npm install
npm test          # 44 tests, no network, no API key
npm run typecheck
npm run dev       # needs .dev.vars — see .dev.vars.example
```

Before it can run for real:

1. Create a Supabase project, run `db/001_init.sql` in the SQL editor.
2. Create an R2 bucket named `subshield-docs`.
3. `wrangler secret put OPENAI_API_KEY` / `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`.
4. Confirm the model id and token rates in `wrangler.toml` against current
   OpenAI pricing — the defaults there are estimates, not verified quotes.
5. Insert a company and a subcontractor row, then open `/u/<upload_token>`.

## The shape of it

```
Inbound email  ─┐
                ├─→  Worker  ─→  extract  ─→  validate  ─┬─→  compliant, filed
Upload page   ─┘                                         └─→  human review queue
                                                                     │
                            daily cron: chase at 30 / 15 / 7 / 0 days ┘
```

## Cost posture

The stack runs on free tiers that permit commercial use. The only recurring costs
before revenue are two domains and an LLM API key — roughly $7/month at 100 clients,
$54/month at 250. See §1 of the spec for what each choice replaced and why.

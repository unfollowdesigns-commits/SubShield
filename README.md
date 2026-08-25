# SubShield

Automated subcontractor Certificate of Insurance (COI) compliance for general
contractors, homebuilders and property managers.

A subcontractor's COI arrives — by email or through an upload link. It gets read,
checked against that client's actual insurance requirements, and either filed as
compliant or escalated to a human. Thirty days before it expires, the subcontractor
starts getting chased automatically. Every decision along the way is logged, because
the audit trail is what the client is really buying.

## Where things stand

Everything in the spec is built. Nothing has been deployed.

Certificates arrive two ways — an upload link (`/u/<token>`) or an inbound alias
(`<client>-certs@process.subshield.io`, one Cloudflare catch-all for every client).
They are read, checked against that client's requirements, and either filed or sent
to a **review queue**. A daily cron chases whoever is lapsing at **30, 15, 7 and 0
days**, copying the client's PM from 7 days on. Clients get a **dashboard**: a
compliance grid, the exception queue, and a printable audit report.

```
src/
  validate.ts     the only thing that decides compliant / not. Pure, tested hard.
  extract.ts      OpenAI structured output, file guards, hashing, retry, cost metering
  prompt.ts       acord_extractor_v1.1 and its strict JSON schema
  matching.ts     which vendor is this? sender address, then fuzzy name, then give up
  pipeline.ts     ingest (with duplicate detection) and the extract→validate→notify path
  email.ts        Cloudflare Email Worker: alias to tenant, attachment picking
  chase.ts        the 30/15/7/0 ladder, batched around the free plan's limits
  review.ts       the side-by-side review screen and its three decisions
  dashboard.ts    compliance grid, exception queue, printable audit report
  notify.ts       Slack blocks, Resend email, and never failing the pipeline
  sign.ts         expiring HMAC links, so nobody needs an account
  db.ts           Supabase over PostgREST — no driver, no connection pooling
  upload-page.ts  the subcontractor's entire experience, one page
  index.ts        Worker entry: fetch, email() and scheduled() handlers
db/               three migrations: schema, holder + duplicates, chase + dashboard views
scripts/          onboard a client from a CSV; mint a dashboard link
```

## The rule that matters

The model extracts. `validate()` decides. It is pure, synchronous and covered by
tests that run without an API key, so no future change can quietly let a model's
opinion become an approval. An empty array of failures — and nothing else — is
the only path to `auto_approved`.

Everything fails closed. An endorsement column the model could not read is not a
checked box. A confidence score of `NaN` is not a passing score. A document that
fails extraction lands in the review queue, never in the bin. A certificate whose
vendor cannot be identified is never auto-approved, however clean it is — filing a
COI against the wrong subcontractor is worse than leaving it in a queue. And a
certificate made out to a *different* general contractor is not evidence of
anything for this one, so the holder block is checked too.

A reviewer's corrections go through the same `validate()` the model's did. The only
way past a failed check is an override, which records who decided and why.

## Running it

```bash
npm install
npm test          # 126 tests, no network, no API key
npm run typecheck
npm run dev       # needs .dev.vars — see .dev.vars.example
```

Before it can run for real:

1. Create a Supabase project, run everything in `db/` in order.
2. Create an R2 bucket named `subshield-docs`.
3. Set secrets: `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
   `LINK_SECRET`, and optionally `RESEND_API_KEY` / `FROM_ADDRESS`.
   Without the Resend pair nothing is emailed and the rest still works.
4. Confirm the model id and token rates in `wrangler.toml` against current
   OpenAI pricing — the defaults there are estimates, not verified quotes.
5. For inbound email: Cloudflare dashboard → Email Routing → catch-all → send to
   the `subshield` Worker, and set each client's `inbound_alias` to match.
6. Onboard a client and print their upload links:

   ```bash
   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... \
     node scripts/onboard.mjs --name "Apex Builders Group" \
       --email ops@apex.example --alias apex-certs --subs vendors.csv

   LINK_SECRET=... node scripts/dashboard-link.mjs --company <uuid>
   ```

7. The chase cron runs daily at 13:00 UTC. Trigger it locally with
   `wrangler dev --test-scheduled` and `curl "localhost:8787/__scheduled"`.

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

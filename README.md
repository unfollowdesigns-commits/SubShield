# SubShield

Automated subcontractor Certificate of Insurance (COI) compliance for general
contractors, homebuilders and property managers.

A subcontractor's COI arrives — by email or through an upload link. It gets read,
checked against that client's actual insurance requirements, and either filed as
compliant or escalated to a human. Thirty days before it expires, the subcontractor
starts getting chased automatically. Every decision along the way is logged, because
the audit trail is what the client is really buying.

## Where things stand

Nothing is built yet. The full build and launch plan lives in
**[BUILD_AND_LAUNCH_SPEC.md](BUILD_AND_LAUNCH_SPEC.md)** — architecture, database
schema, extraction prompt, validation logic, QA matrix, go-to-market and the
financial model.

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
before revenue are a domain and an LLM API key — roughly $5/month at 100 clients,
$50/month at 250. See §1 of the spec for what each choice replaced and why.

# Ratchet scope statement

Status: core delivered (phases 0 to 4)

**Project statement.** Ratchet is a multi-tenant task orchestration platform that turns entity change events into routed, SLA-tracked tasks so multi-step processes never stall.

**Justification.** Teams running multi-step operational processes (loans, onboarding, claims) lose work when the next action lives in someone's head. Ratchet creates that next action automatically when data changes. Personal justification: flagship evidence of end-to-end platform engineering for job applications.

**Product scope.** Event ingest, versioned rules engine, task state machine with SLAs, routing and assignment, GraphQL API, operator and admin consoles, deployed, observable, and documented.

## Objectives and acceptance criteria (must-have, phases 0 to 4)

| # | Criterion | How it is proven |
|---|---|---|
| 1 | Walking skeleton deployed: one posted event creates one task visible in a console at a public URL | Manual demo |
| 2 | Exactly-once task creation per event and rule | Automated duplicate-storm test in CI (`ingest.test.ts`, `pipeline.test.ts`) |
| 3 | Rules versioned with dry-run mode; every decision writes an audit record | `rules.test.ts`, `rule_audit` table |
| 4 | 1,000 events/sec sustained, p95 ingest latency under 200 ms | k6 run in `load/`, which fails the run if p95, error rate, or rate limiting breach thresholds |
| 5 | Operator console reflects queue changes in under 2 seconds | GraphQL subscriptions over WebSocket (ADR-003), `subscriptions.test.ts` |
| 6 | CI green on every merge: lint, typecheck, unit, integration against real Postgres | `.github/workflows/ci.yml` |
| 7 | No cross-tenant read is possible, even through a buggy query | `rls.test.ts`, plus forced RLS as a CI invariant (ADR-005) |

Criterion 4 note: 200 ms is the agreed target, set in `load/README.md` against the k6 threshold. Re-tune it if the hardware changes, and publish server specs alongside any published result.

**Should-have.** Phases 5 to 7: AI layer, scale and ops proof, demo and docs site.

**Nice-to-have.** The expansion list (MongoDB traces, Go ingest, search, notifications, design system, IaC/GitOps, MCP server, and the rest), added one at a time after the core ships.

**Exclusions.** No billing, no SSO, no mobile app, single region. All expansions are excluded from v1 by the sequencing rule.

**Constraints.** Solo developer building with Claude Code. Core stack fixed: TypeScript, React, Node, Postgres, Redis.

**Infrastructure.** Oracle Cloud server (always on): staging and public demo host, k3s and ArgoCD deploy target, self-hosted CI runner, and home for Postgres, Redis, and later Mongo/OpenSearch. Anything beyond the always-free tier is out of budget, which is why every dependency is self-hostable and open source.

## Assumptions

| Issue | Approach |
|---|---|
| Running the app and the load generator on the same server skews numbers | Generate k6 load from a separate machine and publish server specs alongside results |
| Solo availability varies week to week | One-week sprints; the cut line is the phase 0 to 4 core |
| LLM API costs for the AI layer (phase 5) | Free-tier GLM for bulk work, cached eval runs, and the AI layer is a should-have rather than a must-have so it can be dropped |

**Stakeholders.** Initiator, sponsor, implementer: me. Users: demo operators (me plus reviewers). Audience: hiring managers and interviewers.

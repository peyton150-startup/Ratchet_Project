# Ratchet scope statement

(Working name. If you pick another, rename here and everywhere.)

**Project statement.** Ratchet is a multi-tenant task orchestration platform that turns entity change events into routed, SLA-tracked tasks so multi-step processes never stall.

**Justification.** Teams running multi-step operational processes (loans, onboarding, claims) lose work when the next action lives in someone's head. Ratchet creates that next action automatically when data changes. Personal justification: flagship evidence of end-to-end platform engineering for my job applications.

**Product scope.** Event ingest, versioned rules engine, task state machine with SLAs, routing and assignment, GraphQL API, operator and admin consoles, deployed, observable, and documented.

**Objectives and acceptance criteria (must-have, phases 0-4).**

- Walking skeleton deployed by end of week 2: one posted event creates one task visible in a console at a public URL.
- Exactly-once task creation per event and rule, proven by an automated duplicate-storm test in CI.
- Rules are versioned with dry-run mode; every decision writes an audit record.
- 1,000 events/sec sustained in a k6 run with p95 ingest latency under [fill in] ms.
- Operator console reflects queue changes live in under 2 seconds.
- CI green on every merge: lint, typecheck, unit, integration against real Postgres.

**Should-have.** Phases 5-7: AI layer, scale and ops proof, demo and docs site.

**Nice-to-have.** The expansion list (MongoDB traces, Go ingest, search, notifications, design system, IaC/GitOps, MCP server, and the rest), added one at a time after the core ships.

**Exclusions.** No billing, no SSO, no mobile app, single region. All expansions are excluded from v1 by the sequencing rule.

**Constraints.** Solo developer building with Claude Code. Core stack fixed: TypeScript, React, Node, Postgres, Redis. Target date for core complete: [fill in].

**Infrastructure.** Oracle Cloud server (always on): staging and public demo host, k3s and ArgoCD deploy target, self-hosted CI runner, and home for Postgres, Redis, and later Mongo/OpenSearch. Budget cap for anything beyond it: [fill in]/month.

**Assumptions.**

- Issue: running the app and the load generator on the same server skews numbers. Approach: generate k6 load from a separate machine and publish server specs alongside results.
- Issue: solo availability varies week to week. Approach: 1-week sprints; the cut line is the phase 0-4 core.
- Issue: LLM API costs for the AI layer. Approach: monthly spend cap of [fill in], cached eval runs.

**Stakeholders.** Initiator, sponsor, implementer: me. Users: demo operators (me plus reviewers). Audience: hiring managers and interviewers. Reviewers: [fill in 1-2 people who will give feedback].

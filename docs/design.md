# Ratchet design doc

Status: draft | Author: Nic Reilly | Last updated: [date]

## 1. Overview and goals
One paragraph: what Ratchet does and for whom. Link the scope statement.

## 2. Non-goals
Copy the exclusions, plus anything tempting you are deliberately not building.

## 3. System context
Diagram: client systems, Ratchet, consoles, integrator webhooks. [insert diagram]

## 4. Architecture
One subsection per component. Each answers: responsibility, inputs and outputs, why it is separate.
- Ingest API:
- Event log and outbox:
- Rules engine:
  - Must query current application state, not just the incoming event (R7).
  - Event payloads carry the delta; rules can read which fields changed (R10).
  - Rules can be time-triggered by a scheduled scan, not only event-triggered (R11).
- Task service:
- Routing and assignment:
- Consoles:

## 5. Data model
ERD [insert]. Event schema versioning strategy. Partitioning plan for the event log.

## 6. Key flows
Numbered steps or sequence diagrams for: event to task, replay, SLA breach and escalation.

## 7. API design
GraphQL schema sketch for consoles. REST ingest contract. Webhook payloads and signing.

## 8. Multi-tenancy and authz
Tenant isolation model, RBAC roles, where row-level security applies.

## 9. Reliability and failure modes
Idempotency, retry and backoff policy, dead-letter handling, what exactly-once means here and where it breaks down.

## 10. Performance targets
SLOs from the scope statement, plus the load test plan that proves them.

## 11. Observability
Metrics to emit, log structure, trace spans across ingest to rule to task.

## 12. Testing strategy
What gets unit vs integration vs e2e coverage, and the three tests that matter most: duplicate storm, poison message, illegal state transitions.

## 13. Rollout plan
Walking skeleton first, then phase order, cut line restated.

## 14. Open questions
Running list. Each one either becomes an ADR or gets closed with a dated note.

## 15. ADR index
- ADR-001: Outbox vs message broker
- ADR-002: Event log partitioning in Postgres
- ADR-003: GraphQL vs REST for console APIs
- ADR-004: Rules DSL shape (must express state-querying, delta-based, and time-triggered rules per R7/R10/R11)
- ADR-005: Multi-tenancy model
- ADR-006: AI build model split (GLM vs Opus/Fable)

## 16. AI build strategy
Which model builds what, so future audits know the provenance. Tag every PR with the generating model.

**GLM 5.2 (free, NVIDIA API):** scaffolding, CRUD endpoints, React consoles, test boilerplate, seed data, migrations, k6 scripts, docs drafts.

**Opus/Fable:** this design doc and all ADRs, outbox and idempotency, task state machine, rules engine core, auth and row-level security, retry and concurrency logic, per-PR review of GLM kernel code, debugging hard failures, the final whole-scale audit.

Rule: GLM writes what tests can catch; Opus/Fable writes what tests might miss.

## 16. AI build strategy
Which model writes what, so later audits know where to look.

- GLM 5.2 (free, NVIDIA API): scaffolding, CRUD endpoints, React consoles, test boilerplate, seed data, migrations, k6 scripts, docs drafts.
- Opus/Fable: this design doc and all ADRs, outbox and idempotency, task state machine, rules engine, auth and row-level security, retry and concurrency logic, review of every GLM kernel PR, hard debugging, the final whole-scale audit.

Rule: GLM writes what tests can catch; Opus/Fable writes what tests might miss.
Every PR gets a label for the model that wrote it (glm or claude) so the end audit can slice findings by author.

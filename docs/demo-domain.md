# Ratchet demo domain: loan pipeline

This file is the source of truth for the demo. The seed script is just this file turned into inserts. Anything marked [adjust] is a guess; change it freely.

## Stages
application -> document collection -> verification -> underwriting -> conditions -> closing

## Entities
An entity is a thing whose changes Ratchet watches.

- Borrower: id, name, email, credit_score
- LoanApplication: id, borrower_id, amount, stage, status, submitted_at
- Document: id, application_id, type (paystub, W2, bank_statement, ID), status (uploaded, verified, rejected), issued_date
- VerificationResult: id, document_id, outcome (pass, fail), notes, verified_at
- UnderwritingDecision: id, application_id, outcome (approve, deny, conditions), decided_at
- Condition: id, application_id, description, status (open, cleared)

## Event catalog
An event is a fact about a change, posted to the ingest API. Payload always includes entity id plus the changed fields.

| Event | Entity | Fires when |
|---|---|---|
| application.submitted | LoanApplication | borrower submits |
| application.updated | LoanApplication | any field changes (payload carries the delta) |
| application.withdrawn | LoanApplication | borrower cancels |
| document.uploaded | Document | file received |
| document.rejected | Document | reviewer rejects a file |
| verification.completed | VerificationResult | check finishes (payload: outcome) |
| underwriting.decision_recorded | UnderwritingDecision | decision made (payload: outcome) |
| condition.created | Condition | underwriting adds a condition |
| condition.cleared | Condition | condition satisfied |
| borrower.updated | Borrower | borrower data changes, e.g. credit_score |
| closing.scheduled | LoanApplication | closing date set |

## Rules
A rule is: when [event] and [condition], create [task] in [queue] with [SLA].

| # | When | And | Create task | Queue | SLA |
|---|---|---|---|---|---|
| R1 | application.submitted | always | Initial completeness check | intake | 4h |
| R2 | application.submitted | amount > 500000 [adjust] | Senior review | underwriting | 24h |
| R3 | document.uploaded | type is paystub or W2 | Verify income | verification | 24h |
| R4 | document.uploaded | type is bank_statement | Verify assets | verification | 24h |
| R5 | verification.completed | outcome = fail | Request replacement document | intake | 8h |
| R6 | borrower.updated | credit_score < 620 | Manual credit review | underwriting | 48h |
| R7 | verification.completed | all required doc types now verified for the application | Run underwriting | underwriting | 24h |
| R8 | condition.created | always | Collect condition item | processing | 72h |
| R9 | condition.cleared | no open conditions remain | Clear to close | closing | 24h |
| R10 | application.updated | delta includes amount, stage is past underwriting | Re-underwrite | underwriting | 24h |
| R11 | scheduled sweep [see note] | document issued_date older than 60 days at underwriting | Request updated document | intake | 24h |
| R12 | application.withdrawn | always | Cancel open tasks and close file | intake | 8h |

## Notes
- R7 is the hard one: its condition spans multiple entities, which forces the rules engine to query current state, not just the incoming event.
- R10 is delta-based: it only fires when a specific field changed. Good test for versioned rules and dry-run.
- R11 is time-based, not event-based: it needs a scheduled scan. Decide in ADR-004 whether sweeps are a rule type or a separate mechanism.
- R12 is cascading cleanup: it acts on tasks Ratchet itself created.

## Queues
intake, verification, underwriting, processing, closing

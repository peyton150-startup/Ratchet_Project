# ADR-004: Rules DSL shape

**Status:** Accepted (2026-07-21)
**Decision:** Option A — structured, versioned JSON condition tree, with sweeps modeled as a
rule trigger type, three condition namespaces, allowlisted `state.*` predicates, and an action union.

## Context

A rule is: when [event] and [condition], create [task] in [queue] with [SLA]. Rules are versioned
JSON, support dry-run, and every decision writes an audit record with the rule version that fired
(Phase 2b). Phase 4 adds a visual rule builder and version diffs. So the shape must be serializable,
versionable, diffable, safe to evaluate, and round-trippable through a GUI.

Three rules force the design:
- **R7 (cross-entity state):** condition spans multiple entities/current state; the event payload is
  not enough — the engine must query current state.
- **R10 (delta-based):** must fire on *what changed*, distinct from current field values.
- **R11 (time-triggered):** no event fires it; needs a scheduled scan. demo-domain.md deferred to
  this ADR whether sweeps are a rule type or a separate mechanism.
- **R12 (cascading cleanup):** acts on tasks Ratchet itself created, so actions aren't only "create task."

## Options considered

- **A — Structured JSON condition tree.** Fixed operator set over three namespaces; safe (no eval),
  structurally diffable, natively round-trips in a visual builder. Bounded expressiveness, mitigated
  by named host predicates.
- **B — Embedded expression language (CEL/JSONLogic).** Expressive, mature, sandboxed, but condition
  strings are harder to diff and to round-trip in a GUI; R7 still needs host functions.
- **C — Code/scripting per rule.** Maximum power; not declarative, poor diffing, sandbox burden,
  visual builder near-impossible. Rejected.

## Decision (Option A) — the four settled points

1. **Trigger discriminated union — sweeps ARE a rule type.** Every rule has `trigger`:
   `{type:"event", event:"…"}` or `{type:"schedule", cron:"…", scan:{…}}`. R11 rides the same
   versioning/dry-run/audit path as event rules. (Answer to the demo-domain deferral: rule type,
   not a separate mechanism.)
2. **Three explicit condition namespaces:** `event.*` (payload), `delta.*` / `changed(field)`
   (R10 — "did it change", first-class and distinct from current values), and `state.*`
   (current state).
3. **Named, allowlisted `state.*` predicates** as the escape hatch for R7 and anything too complex
   for the inline grammar. Cross-entity logic ("all required docs verified") lives in a tested host
   predicate, not in the DSL.
4. **Action union:** `create_task {queue, sla, priority, template}` and `cancel_tasks {…}` — so
   R12's cleanup on Ratchet-created tasks is expressible, not bolted on later.

Operator set (initial): `eq, neq, gt, lt, gte, lte, in, and, or, not`, plus `changed(field)`.

## Rationale

- Phase 4's diffable versions and visual builder both strongly favor a structured tree: a GUI edits
  and renders a tree natively and diffs are structural/meaningful, whereas CEL strings need a
  parser/generator and diff as line noise.
- Safety/auditability are free: no eval/sandbox; the audit record captures the evaluated tree +
  `state` predicate results alongside the rule version.
- The predicate allowlist turns bounded expressiveness into the design doc's build split — R7's
  predicate is tested host code; the JSON stays simple and safe.
- One trigger union means one rules engine, one audit trail, one admin console — important for a solo dev.

## Consequences

- We define and maintain the operator grammar and the `state.*` predicate allowlist.
- Very complex conditions must be promoted to named host predicates (tested code) rather than inline JSON.
- Audit records store the rule version and the evaluated condition/predicate results for replay and dry-run.
- CEL (Option B) remains the fallback if free-form author expressions ever outweigh GUI diff/round-trip needs.

# Operator lifecycle: design

Status: approved 2026-10-02

## Problem

The operator console uses only part of what the backend can do with a task.

- A blocked task has no buttons. The state machine defines `unblock`, `release` and `cancel`, but
  the API exposes mutations only for `claim`, `complete` and `block`, and the console hard-codes
  those three.
- Every task is auto-assigned to an agent by the worker, and the console fetches `assignee`, but
  never shows it. It is a bare UUID with no way to resolve a name.
- The task list has no state filter. Completed and cancelled tasks stay in the list and eventually
  fill the 100-row limit, pushing live work out.
- Event history shows only type and time, though the API returns `payload` and `delta`.
- The "connecting…" badge turns to "live" on the first task update rather than when the socket
  connects, and a failed subscription is logged to the browser console and nowhere else.
- An error message, once shown, never clears.

## API

All additions follow the existing patterns in `packages/api/src/graphql/schema.ts`.

- `unblockTask(id)`, `releaseTask(id)`, `cancelTask(id)`: go through `transitionMutation`, so the
  shared transition table stays the only definition of what is legal. Each requires `tasks:work`
  and publishes the updated task to the live feed.
- `Task.assigneeName: String`: the assigned agent's name, filled by a `LEFT JOIN agents` in
  `packages/api/src/tasks/read.ts`. It is part of `TaskView`, so tasks published by the worker and
  by mutations carry it too. No general agents API is added.
- `tasks(activeOnly: Boolean)`: restricts the list to open, claimed and blocked tasks. It combines
  with `queue` and `state`.

SDK: `unblockTask`, `releaseTask`, `cancelTask`; `assigneeName` on `Task`; `activeOnly` on
`TaskFilter`.

## Console

- **Actions.** A row shows every action `allowedActions(state)` returns except `cancel`. Cancel
  lives in the detail panel and needs a second click to confirm, because it is terminal.
- **Assignee.** A column in the table and a line in the detail panel. Shows the agent name, or
  "unassigned".
- **State filter.** Chips above the table: Active (default), open, claimed, blocked, completed,
  cancelled. Active sends `activeOnly: true`; the others send `state`. It combines with the queue
  filter. A live update for a task that no longer matches the filter removes the row; the detail
  panel keeps showing the selected task.
- **Event history.** Each event expands to show its payload and delta.
- **Connection badge.** Driven by the graphql-ws client's own events: connecting, live,
  reconnecting, offline. Subscription errors are shown in the page.
- **Errors.** Dismissible, and cleared when the next action succeeds.

## Out of scope

- Recording who claimed a task. Claim changes only the state; API keys are not tied to agents.
- Managing agents and queue membership.
- Restricting cancel to admins. It uses `tasks:work`, like the other transitions.

## Rollout note

The console asks for `assigneeName` in every task query. A console deployed before the API that
knows the field gets a GraphQL validation error on every task request, so the API must be live
first. Vercel finishes before Northflank on a merge; expect the console to error until the API
rebuild completes.

## Tests

- API (`graphql.test.ts`): the three transitions, one illegal transition, `activeOnly`,
  `assigneeName`.
- SDK (`sdk.test.ts`): the three new methods.
- Web (`operator.test.tsx`, `tasks.test.ts`): buttons per state, cancel confirmation, state filter,
  connection badge, filter-aware live updates.
- Browser: claim, block, unblock, release and cancel on the local stack.

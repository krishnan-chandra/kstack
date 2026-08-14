# Plan 007: Guard panel-review against concurrent runs and stale-session UI

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat d0a9409..HEAD -- extensions/panel-review/index.ts extensions/panel-review/api.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW — additive guard; the runner logic is untouched.
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `d0a9409`, 2026-08-14

## Why this matters

Unlike its sibling extensions, panel-review has **no concurrency or session
lifecycle guard**. `plan-implement` has `WorkflowLifecycle` (session tokens +
`isRunning()` + child controllers) and `pr-autopilot` has `AutopilotLifecycle`;
panel-review tracks only a module-level `AbortController`:

- Two `/panel-review` invocations (or a slash command racing an in-process
  request from plan-implement/kstack-router) run **concurrently**: two
  reviewer panels, two dashboards, interleaved `setStatus` writes.
- `activeAbort` is overwritten by the second run, so Ctrl+Shift+X aborts only
  the newest run; the first becomes unabortable.
- After `session_shutdown`, in-flight code still calls `ctx.ui`/`pi.sendMessage`
  on a stale context (the shutdown hook only aborts; the awaited continuation
  resumes with old `ctx`).

## Current state

- `extensions/panel-review/index.ts:73`: `let activeAbort: AbortController | undefined;`
  set inside `runPanelReview` (~line 244: `runAbort = abort; activeAbort = abort;`),
  cleared in the `finally`.
- `runPanelReview` is a ~300-line closure; entry points: the `panel-review`
  command handler and `pi.events.on(PANEL_REVIEW_REQUEST_EVENT, …)` at the
  bottom of the file. `session_shutdown` handler aborts `activeAbort`.
- The pattern to copy: `extensions/pr-autopilot/lifecycle.ts`
  (`AutopilotLifecycle`: `startSession`/`shutdownSession`/`currentSessionToken`/
  `isSessionCurrent`/`beginRun`/`endRun`/`isCurrent`) with its tests in
  `lifecycle.test.ts`. Read both before writing code; mirror the shape (a
  panel run has no child phases, so the simpler autopilot lifecycle fits
  better than plan-implement's).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | `node --test extensions/panel-review/*.test.ts` | `fail 0` |
| Typecheck (if plan 003 landed) | `npm run typecheck` | exit 0 |

## Scope

**In scope**:
- `extensions/panel-review/index.ts`
- `extensions/panel-review/lifecycle.ts` (create) + `lifecycle.test.ts` (create)

**Out of scope**:
- `reviewer-runner.ts`, `orchestrator.ts`, `review-scope.ts`, `synthesis.ts`,
  `live-dashboard.ts`, prompts
- `api.ts` request contract (callers must not need changes)
- Any change to the review flow itself (confirm dialog, dashboard, synthesis)

## Git workflow

- Branch: `kstack/panel-review-run-guard`
- Two commits: lifecycle module + wiring. Do NOT push or open a PR unless
  instructed.

## Steps

### Step 1: Create the lifecycle module

`extensions/panel-review/lifecycle.ts`, modeled on
`extensions/pr-autopilot/lifecycle.ts` (copy its token discipline; rename
types to `PanelLifecycle`). Port the applicable tests from
`extensions/pr-autopilot/lifecycle.test.ts` into
`extensions/panel-review/lifecycle.test.ts`: session token invalidated by
shutdown; `beginRun` fails while a run is active; `endRun` idempotent;
`isCurrent` false for a stale token.

**Verify**: `node --test extensions/panel-review/lifecycle.test.ts` → `fail 0`.

### Step 2: Wire it into runPanelReview

At the top of `runPanelReview` (after the `hasUI` check):
- `const session = lifecycle.currentSessionToken(); if (!session) return {status:"failed", error:"no active session"};`
- reject when running: if `lifecycle.isRunning()`, notify
  `"A panel review is already active. Press Ctrl+Shift+X to abort it."` and
  return `{ status: "failed", error: "a panel review is already running" }`.
- `beginRun` **after** the user confirms (mirror pr-autopilot: token checked
  again post-confirm, since the confirm dialog awaits user input), `endRun`
  in the existing `finally`.
- Gate every post-await UI touch (`notify`, `setStatus`, `pi.sendMessage`,
  dashboard mount) with `lifecycle.isCurrent(token)` — same discipline as
  `pr-autopilot/index.ts`'s `updateStatus`.
- Register `pi.on("session_start", () => lifecycle.startSession())` and move
  the abort into `pi.on("session_shutdown", …)` alongside
  `lifecycle.shutdownSession()`. Keep `activeAbort` for the shortcut, but set
  it only when `beginRun` succeeded.

Return-shape note: `PanelReviewOutcome` already has a `failed` variant —
reuse it; do not add new variants (in-process callers in plan-implement and
kstack-router switch on the existing statuses).

**Verify**: `node --test extensions/panel-review/*.test.ts` → `fail 0`.

### Step 3: Prove the guard

If `index.ts` has no direct test today (registration is exercised via the
e2e script), add a focused unit test only if the guard logic is extracted
into a testable helper; otherwise verify by the lifecycle tests plus a manual
check listed in the report: run `/panel-review` twice quickly in a scratch
repo and observe the second invocation is rejected with the notify message.

**Verify**: documented manual check or new unit test; full suite `fail 0`.

## Test plan

- New `lifecycle.test.ts` (ported cases, Step 1).
- Existing panel-review suites must pass unchanged.

## Done criteria

- [ ] `node --test extensions/panel-review/*.test.ts` exits 0, `fail 0`
- [ ] `extensions/panel-review/lifecycle.ts` exists with tests
- [ ] `grep -n "isRunning" extensions/panel-review/index.ts` shows the reject path
- [ ] In-process API callers unchanged (`git diff --name-only` does not include plan-implement or kstack-router files)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Enforcing single-run breaks plan-implement's flow (it requests a panel
  review while itself holding a workflow token — that is fine, the guard is
  *within* panel-review; but if any test orchestrates overlapping reviews
  deliberately, report before changing it).
- The `PanelReviewOutcome` type cannot express the rejection without a new
  variant — report rather than extending the public union.

## Maintenance notes

- Once this lands, all four workflow extensions share the same lifecycle
  discipline; a future consolidation into `extensions/shared/` (like plan 004
  did for runners) becomes mechanical — deliberately not done here (two
  implementations exist today; three justify extraction).
- Reviewer: check every `await` boundary in `runPanelReview` for an
  unguarded `ctx.ui` use after this change.

# Plan 012: Extract one shared session-lifecycle core from four copies

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7e18fff..HEAD -- extensions/plan-implement/lifecycle.ts extensions/pr-autopilot/lifecycle.ts extensions/panel-review/lifecycle.ts extensions/kstack-router/lifecycle.ts extensions/shared/`
> If any lifecycle file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW–MED — lifecycle bugs manifest as stale-context UI writes or
  un-abortable children. All four modules have colocated tests that define
  the contract; the extraction is compose-don't-inherit.
- **Depends on**: none (repo has typecheck + green CI since plans 002/003)
- **Category**: tech-debt
- **Planned at**: commit `7e18fff`, 2026-08-14

## Why this matters

Four extensions carry the same session-generation lifecycle core:

- `extensions/pr-autopilot/lifecycle.ts` (59 lines, `AutopilotLifecycle`)
- `extensions/panel-review/lifecycle.ts` (49 lines, `PanelLifecycle`)
- `extensions/plan-implement/lifecycle.ts` (85 lines, `WorkflowLifecycle`)
- `extensions/kstack-router/lifecycle.ts` (107 lines, `RouterLifecycle`)

`AutopilotLifecycle` and `PanelLifecycle` are **structurally identical**
(generation counter, sessionActive, single `running` flag, token
begin/end/isCurrent). `WorkflowLifecycle` is that same core plus a child
`AbortController` and a phase enum. `RouterLifecycle` is the same session
core plus dispatch/classifier state. The core invariants — "a token minted
before `session_shutdown` is never current afterwards", "one run at a time",
"begin fails against a stale session token" — are safety-critical (they are
what stops a replaced session's UI from being written to) and are currently
maintained in four places. Panel-review's copy exists only because plan 007
had to duplicate pr-autopilot's; a third copy was this repo's stated
extraction trigger (plan 007 maintenance note: "a future consolidation into
`extensions/shared/`… becomes mechanical").

## Current state

- Shared-module precedent: `extensions/shared/child-agent-runner.ts` and
  `extensions/shared/kstack-config.ts` (plans 004/005) — plain modules with
  colocated `*.test.ts`, no Pi imports. Follow that pattern.
- The identical core, from `extensions/panel-review/lifecycle.ts` (entire
  file, 49 lines):

```ts
export interface PanelToken { readonly generation: number; }
export class PanelLifecycle {
	private generation = 0;
	private sessionActive = false;
	private running = false;
	startSession(): void { this.generation++; this.sessionActive = true; this.running = false; }
	shutdownSession(): void { this.sessionActive = false; this.generation++; this.running = false; }
	currentSessionToken(): PanelToken | undefined { … }
	isSessionCurrent(token: PanelToken): boolean { … }
	beginRun(token: PanelToken): PanelToken | undefined { … }
	endRun(token: PanelToken): void { … }
	isRunning(): boolean { … }
	isCurrent(token: PanelToken): boolean { … }
}
```

  `AutopilotLifecycle` (pr-autopilot) has the same nine members with the
  token type named `AutopilotToken`.
- `WorkflowLifecycle` (plan-implement) additions on top of the core:
  `phase: WorkflowPhase` (`"idle" | "planning" | "approval" | "implementing" | "fixing" | "publishing"`),
  `childAbort: AbortController | undefined`, methods `beginWorkflow`
  (= beginRun that also sets phase "approval"), `beginChild(token, phase)`,
  `endChild(token, controller)`, `abortActiveChild()`,
  `finishWorkflow(token)` (aborts child), `currentPhase()`.
  Note: `shutdownSession` also aborts `childAbort`.
- `RouterLifecycle` (kstack-router) additions: `dispatchIdCounter` and
  compound `DispatchToken { generation, dispatchId }`, `currentRoute`,
  `toolSnapshot`, `classifier: AbortController`, methods
  `beginClassifier/endClassifier/abortClassifier`,
  `beginDispatch/getActiveDispatch/getToolSnapshot/isCurrentDispatch/endDispatch`.
  Its `sessionToken()` returns a structural `{ generation: number }` (not a
  branded type) — callers in `kstack-router/index.ts` rely on that shape.
- Each module has a colocated test file
  (`lifecycle.test.ts` in all four directories). Those assertions are the
  behavioral contract; keep them passing, moving genuinely-core cases into
  the shared suite where duplicated.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `npm run typecheck` | exit 0 |
| Full tests | `npm test` | exit 0, `fail 0` |
| Focused | `node --test extensions/shared/*.test.ts` | `fail 0` |

## Scope

**In scope**:
- `extensions/shared/session-lifecycle.ts` (create) + `session-lifecycle.test.ts` (create)
- The four `lifecycle.ts` files above (shrink to re-exports/compositions)
- Their four `lifecycle.test.ts` files (retarget; keep extension-specific cases)
- Import sites **only if type names change** — prefer keeping every public
  type/class name (`PanelLifecycle`, `AutopilotLifecycle`, `WorkflowLifecycle`,
  `RouterLifecycle`, their token types) so `index.ts` files need no edits.

**Out of scope**:
- Any `index.ts` behavior change in any extension
- Renaming public lifecycle APIs that index.ts files call
- The in-process request/claim pattern (recorded as rejected in the index)

## Git workflow

- Branch: `kstack/shared-session-lifecycle`
- Commits: shared module + tests first, then one commit per extension
  migration. Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create the shared core

`extensions/shared/session-lifecycle.ts`:

```ts
export interface SessionToken { readonly generation: number; }

/** Generation-counted session guard: one active run, stale tokens never current. */
export class SessionRunLifecycle {
	// the nine core members exactly as in PanelLifecycle today
	startSession(): void; shutdownSession(): void;
	currentSessionToken(): SessionToken | undefined;
	isSessionCurrent(token: SessionToken): boolean;
	beginRun(token: SessionToken): SessionToken | undefined;
	endRun(token: SessionToken): void;
	isRunning(): boolean;
	isCurrent(token: SessionToken): boolean;
	/** Hook for subclasses/compositions: called by shutdownSession after invalidation. */
	protected onShutdown(): void {}
}
```

Design rule: **composition or narrow subclassing, caller's choice, but the
core state (`generation`, `sessionActive`, `running`) must live in exactly
one class.** If subclassing, keep the fields private and expose the
`onShutdown()` hook so plan-implement can abort its child and kstack-router
its classifier. If composition reads cleaner for RouterLifecycle (it has no
`running` flag today — dispatch presence plays that role), wrap a
`SessionGenerations` micro-core (generation + sessionActive + token methods)
instead and let `SessionRunLifecycle` add `running` on top. Decide after
reading all four test files; state the decision in the module docstring.

Port the shared behavioral tests into `session-lifecycle.test.ts`: token from
one generation invalid after shutdown; begin fails when running; begin fails
with stale token; endRun idempotent and generation-checked; isCurrent false
before beginRun.

**Verify**: `node --test extensions/shared/session-lifecycle.test.ts` →
`fail 0`; `npm run typecheck` → exit 0.

### Step 2: Migrate panel-review and pr-autopilot

Replace each class body with the shared core, keeping the exported names:

```ts
// extensions/panel-review/lifecycle.ts
export type PanelToken = SessionToken;
export class PanelLifecycle extends SessionRunLifecycle {}
```

(Or `export { SessionRunLifecycle as PanelLifecycle }` — but check first that
`index.ts` only uses the nine core members; it does at `7e18fff`.)

**Verify after each**: `node --test extensions/<name>/*.test.ts` → `fail 0`;
`npm run typecheck` → exit 0.

### Step 3: Migrate plan-implement

`WorkflowLifecycle` keeps its extra members (`beginWorkflow`, `beginChild`,
`endChild`, `abortActiveChild`, `finishWorkflow`, `currentPhase`) but drops
its private copies of the core state, delegating to the shared core.
`beginWorkflow` = core `beginRun` + set phase `"approval"`; `shutdownSession`
child-abort moves into the `onShutdown()` hook. Its public API must not
change (`index.ts` and `phases.ts` consume it).

**Verify**: `node --test extensions/plan-implement/*.test.ts` → `fail 0`.

### Step 4: Migrate kstack-router

Replace the session-generation plumbing (`generation`, `sessionActive`,
`sessionToken`, `isSessionCurrent`) with the shared core; keep every
dispatch/classifier member and the structural `{ generation: number }`
return type of `sessionToken()` (a `SessionToken` satisfies it).

**Verify**: `node --test extensions/kstack-router/*.test.ts` → `fail 0`,
including the headless smoke test if it is part of the suite
(`node extensions/kstack-router/scripts/smoke-mock-pi.mjs` if the README
names it — check `extensions/kstack-router/README.md`).

### Step 5: Confirm single ownership of the invariant

**Verify**:
`grep -rn "generation++" extensions/ --include="*.ts" | grep -v shared/ | grep -v test` → no results.
`npm test` → `fail 0`.

## Test plan

- New `extensions/shared/session-lifecycle.test.ts` (Step 1 cases).
- Four existing lifecycle test suites keep passing; cases that duplicate the
  shared core may move to the shared suite (report the before/after test
  counts — total must not decrease by more than the deduplicated cases).

## Done criteria

- [ ] `npm run typecheck` exits 0; `npm test` exits 0 with `fail 0`
- [ ] `extensions/shared/session-lifecycle.ts` exists with tests
- [ ] Step 5 grep shows generation state only in shared/
- [ ] No `index.ts` file changed (`git diff --name-only` contains no index.ts)
- [ ] Each extension lifecycle file ≤ 60 lines (router ≤ 90, it keeps dispatch state)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Keeping the four public class/token names requires exporting the shared
  class under aliases in a way tsc rejects (branded-token mismatch) — report
  the exact error; renaming public APIs is out of scope for this plan.
- Router's compound `DispatchToken` cannot be expressed over the shared core
  without changing `isCurrentDispatch` semantics.
- Any `index.ts` file needs edits to keep tests green.

## Maintenance notes

- Future extensions get their lifecycle from `extensions/shared/` from day
  one; mention it in the create-pi-extension ground rules next time that
  file is edited (out of scope here).
- Reviewer: the invariant to scrutinize is shutdown ordering — invalidate
  generation **before** running abort hooks, exactly as the current copies do
  (`shutdownSession` increments, then aborts), so an abort callback can never
  observe a still-current token.

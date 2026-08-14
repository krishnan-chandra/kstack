# Plan 013: Characterization tests for the pr-autopilot drive loop

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7e18fff..HEAD -- extensions/pr-autopilot/driver.ts extensions/pr-autopilot/autopilot-operations.ts extensions/pr-autopilot/pr-state.ts`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW — additive tests plus one narrow injection seam with
  defaulted parameters; no behavior change.
- **Depends on**: none (soft: land before plan 012 touches nothing here;
  orthogonal)
- **Category**: tests
- **Planned at**: commit `7e18fff`, 2026-08-14

## Why this matters

`extensions/pr-autopilot/driver.ts` (470 lines) contains `runAutopilot` —
the while-loop that decides when the autopilot **pushes commits to real
PRs**, merges base branches, replies to review threads, and re-triggers CI.
It is the highest-consequence code path in the repository and has **zero
direct tests**: `autopilot.test.ts` covers the pure fragments (state
predicates, triage parsing, task building) but never executes a drive cycle.
The loop's regressions (skipping the mutation-checkout guard, pushing after
`VERIFY_FAIL`, looping past `maxFixCycles`, acting on `ask` threads) would
ship silently today. Plan 009 isolated the loop behind injected
`exec`/`handlers`/`signal` precisely so it could be tested; this plan pays
that off.

## Current state

- `extensions/pr-autopilot/driver.ts:78` —
  `runAutopilot(mode, params, handlers, signal)`:
  - `params`: `{ config, exec: ExecFn, cwd, explicitPR?, promptDir, triagerPromptFile, fixerPromptFile }`
  - `handlers`: `{ setPhase(phase, cycles?), notify(msg, level), confirm(label, body) }`
  - `exec` is already injectable — all git/gh calls flow through it.
- **Not yet injectable** (module-level imports in driver.ts:47–53):
  - `runChildRole` from `./autopilot-operations.ts:136` (spawns real Pi
    children via `runAgent`) — used at driver.ts:299 (triager) and :385
    (fixer);
  - `loadPersistedState`/`savePersistedState` (read/write real files under
    `tmpdir()`);
  - `writeFile` from `node:fs/promises` (writes triager/fixer task files
    into `promptDir`).
  Task files can go to a real temp dir in tests (harmless); the child-role
  runner and persistence need a seam.
- The loop's externally observable contract (from reading driver.ts at
  `7e18fff`): check mode does two `fetchPRState` reads and never mutates;
  drive mode refuses to mutate when `prepareMutationCheckout` fails; a
  conflicting/behind PR triggers `mergeBaseIntoHead` then push; pending
  checks with nothing actionable → `watchChecks` instead of a triager run;
  triage `ask` threads → blocked with reasons; `VERIFY_FAIL` in fixer output
  → no push (`doCommitAndPush` guard); push not confirmed → status
  `incomplete`; cycles bounded by `maxFixCycles(mode)`.
- Test conventions: `node:test`, fake `ExecFn`s returning canned
  `{ code, stdout, stderr }` by matching command/args — see the existing
  fakes in `extensions/pr-autopilot/autopilot.test.ts` and
  `github.test.ts`; model the new fakes on those.
- `ExecFn`/`ExecFnResult` types: `extensions/pr-autopilot/types.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `npm run typecheck` | exit 0 |
| Focused | `node --test extensions/pr-autopilot/*.test.ts` | `fail 0` |
| Full | `npm test` | `fail 0` |

## Scope

**In scope**:
- `extensions/pr-autopilot/driver.ts` — **only** to add an optional `ops`
  parameter (defaulted; see Step 1)
- `extensions/pr-autopilot/driver.test.ts` (create)
- `extensions/pr-autopilot/index.ts` — only if the `runAutopilot` call site
  needs a no-op change (it should not; the new param is optional)

**Out of scope**:
- Any control-flow change in the loop
- `autopilot-operations.ts`, `pr-state.ts`, `github.ts` implementations
- Existing test files

## Git workflow

- Branch: `kstack/driver-characterization-tests`
- Two commits: seam, then tests. Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add the injection seam (defaulted, zero behavior change)

In `driver.ts`, add a fourth-or-merged optional parameter:

```ts
export interface DriverOps {
	runChildRole: typeof runChildRole;
	loadPersistedState: typeof loadPersistedState;
	savePersistedState: typeof savePersistedState;
}
const defaultOps: DriverOps = { runChildRole, loadPersistedState, savePersistedState };

export async function runAutopilot(
	mode: AutopilotMode,
	params: { …unchanged… },
	handlers: { …unchanged… },
	signal: AbortSignal,
	ops: DriverOps = defaultOps,
): Promise<AutopilotResult> {
```

Replace the direct calls at the three-plus call sites (`runChildRole` ×2,
`loadPersistedState` ×2, `savePersistedState` ×N) with `ops.*`. Everything
else (fetchPRState, prepareMutationCheckout, doCommitAndPush, watchChecks,
mergeBaseIntoHead) already flows through `exec` — do not seam those; the
tests drive them through the fake `ExecFn`.

**Verify**: `npm run typecheck` exit 0;
`node --test extensions/pr-autopilot/*.test.ts` `fail 0` (no existing test
changes needed — the parameter is optional).

### Step 2: Build the test harness

In `driver.test.ts`, build:
- `fakeExec(script)`: an `ExecFn` that matches on `command` + first args
  (`gh pr view`, `gh pr checks`, `git status --porcelain`, `git rev-parse
  HEAD`, `git branch --show-current`, `git push`, …) against a mutable
  scenario object, recording every call. Unmatched calls → return
  `{ code: 1, stderr: "unexpected: …" }` so tests fail loudly. Base the
  canned `gh` JSON on the literal payloads already used in
  `autopilot.test.ts`/`github.test.ts`.
- `fakeOps`: in-memory persisted state (Map), `runChildRole` returning
  scripted triage JSON / fixer output per invocation.
- `handlers` recorder: notes every `notify`, auto-answers `confirm` from a
  script, records `setPhase` sequence.
- Use a real `mkdtemp` prompt dir per test; clean up in `t.after`.

**Verify**: a trivial smoke case (check mode, clean mergeable PR, no
threads, green checks) returns `status: "merge-ready"` …or whatever check
mode actually returns for ready (`"merge-ready"` per driver.ts) — assert the
observed value after reading the code, do not guess.

### Step 3: Characterize the safety-critical paths (≥8 cases)

1. **check mode never mutates**: no `git push`/`git add`/`git commit`/
   `gh api …comments` in the recorded exec calls.
2. **dirty worktree blocks mutation**: `git status --porcelain` returns
   content → drive mode returns `blocked`, no triager invocation.
3. **branch/HEAD mismatch blocks**: checkout on wrong branch →
   `blocked`, error names both branches.
4. **behind base → merge + push**: `mergeStateStatus: "BEHIND"` → exec
   records `git fetch`, `git merge --no-edit origin/<base>`, `git push`;
   cycle continues.
5. **ask threads block without fixing**: triage marks a thread `ask` and
   nothing else actionable → `blocked`, `blockedReasons` includes the
   thread id, fixer never invoked.
6. **VERIFY_FAIL never pushes**: fixer output contains `VERIFY_FAIL` →
   no `git push` recorded, result not `merge-ready`.
7. **push declined → incomplete**: confirm script answers `false` for the
   push → status `incomplete`, reason `"push not confirmed"`.
8. **cycle bound respected**: triage always returns a fixable code check,
   fixer always "fixes", state never becomes ready → loop ends after
   `maxFixCycles("drive")` cycles with `status: "blocked"` and
   `"max cycles reached…"` in reasons.
9. (bonus) **pending-checks watch path**: pending checks, nothing else →
   exec records `gh pr checks --watch`, no triager run.

Each case asserts on *recorded exec calls* plus the returned
`AutopilotResult` — characterization, not implementation details like phase
strings (assert those only where the plan's contract names them).

**Verify**: `node --test extensions/pr-autopilot/driver.test.ts` → `fail 0`,
≥8 tests.

## Test plan

Steps 2–3 are the test plan. Pattern source:
`extensions/pr-autopilot/autopilot.test.ts` (fake ExecFn style) and
`extensions/plan-implement/workflow.test.ts` (scripted-handler style).

## Done criteria

- [ ] `npm run typecheck` exits 0; `npm test` exits 0 with `fail 0`
- [ ] `extensions/pr-autopilot/driver.test.ts` exists with ≥8 passing tests
- [ ] `git diff 7e18fff..HEAD -- extensions/pr-autopilot/driver.ts` shows only
      the `ops` seam (parameter + `ops.` call-site prefixes), no control-flow edits
- [ ] Case 1's no-mutation assertion enumerates the recorded calls (not a
      vacuous "nothing threw")
- [ ] `plans/README.md` status row updated

## STOP conditions

- The loop cannot reach a listed scenario with `exec`+`ops` fakes alone
  (hidden module-level dependency I missed) — name it; do not widen the seam
  beyond `DriverOps` without reporting first.
- Any existing test needs modification.
- A characterization test *fails against current behavior* — that is a
  real-bug discovery, not a test to adjust; report which case and what the
  loop actually did.

## Maintenance notes

- These tests are the safety net for the land-workflow integration
  (plans/land-workflow.md) which will consume this loop's merge-ready
  evidence; extend `driver.test.ts` when that lands.
- Reviewer: audit the fakes for over-matching (a fake that answers every
  `gh` call with success can make case 1 pass vacuously — unmatched calls
  must fail loudly).

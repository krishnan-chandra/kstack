# Plan 009: Split the pr-autopilot driver module

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat d0a9409..HEAD -- extensions/pr-autopilot/`
> Plans 003/004/006 will have touched types, the runner, and github/persist
> code. Re-read `autopilot.ts`'s current section boundaries before cutting.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED — the drive loop's cycle/continue/break structure is easy to
  subtly change. Mitigation: pure moves, no control-flow edits, suite gates.
- **Depends on**: plans/004-shared-child-agent-runner.md (and 006 should land
  first to avoid rebase churn in the same functions)
- **Category**: tech-debt
- **Planned at**: commit `d0a9409`, 2026-08-14

## Why this matters

`extensions/pr-autopilot/autopilot.ts` is 1,122 lines — the largest source
file in the repo (repo median for extension modules is ~300) — and mixes five
concerns: PR-state predicates, task-prompt building, triage-JSON parsing,
persisted-state I/O, git commit/push/cleanup, and the ~450-line `runAutopilot`
driver whose while-loop mutates five closure variables (`state`, `persisted`,
`verifiedHeadSha`, `cycle`, `blockedReasons`). `autopilot.test.ts` (350 lines)
tests only the pure fragments; the driver itself is effectively untested and
unreadable in review. Splitting along the existing seams makes the next
behavior change (and the land-workflow integration, which consumes
merge-ready evidence from this module) reviewable.

## Current state

Section map of `autopilot.ts` at `d0a9409` (verify against live file):

- Lines ~85–175: pure state predicates — `buildPRState`, `checksGreen`,
  `hasPendingChecks`, `hasFailingChecks`, `isCodeReady`, `isMergeReady`,
  `describeBlockers`.
- ~176–280: prompt builders — `clipBody`, `buildTriagerTask`,
  `buildFixerTask`, `FixMode`.
- ~283–297: `pickModel` (note: its `_role` parameter is unused — drop it and
  update the two call sites).
- ~299–345: persistence — `persistPath`, `loadPersistedState`,
  `savePersistedState` (reshaped by plan 006 to take a repo key).
- ~347–420: `fetchPRState`, `runTriager`, `runFixer` (runTriager/runFixer are
  near-identical — unify into one `runChildRole(role, tools, …)` helper).
- ~421–520: git mutation — `prepareMutationCheckout`,
  `restoreForbiddenPaths`, `doCommitAndPush`, `runCleanup`.
- ~522–640: triage parsing — `parseFailureClass`, `parseDecision`,
  `ParsedCheck/ParsedThread/ParsedTriage`, `parseTriage`, `applyForceAsk`,
  `summarizeTriage`, `classifyBlockers`, `applyThreadReplies`.
- ~652–1122: `maxFixCycles` + `runAutopilot` driver.

Also (from the audit, cosmetic, in `index.ts`): `sendPhaseMessage(pi, mode,
phase, 0, modelList, phase)` hardcodes `cycles: 0` in every progress card —
thread the real cycle count through the `setPhase` callback while you are
here (smallest possible change: widen the callback to
`setPhase(phase, cycles?)`).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `npm run typecheck` | exit 0 |
| Focused | `node --test extensions/pr-autopilot/*.test.ts` | `fail 0` |
| Full | `npm test` | `fail 0` |

## Scope

**In scope**:
- `extensions/pr-autopilot/autopilot.ts` (shrinks to the driver + predicates,
  or driver only)
- New files: `extensions/pr-autopilot/pr-state.ts`, `triage.ts`, `tasks.ts`,
  `persist.ts`, `git-mutation.ts` (names indicative; keep them cohesive, do
  not create a file per function)
- `extensions/pr-autopilot/autopilot.test.ts` (split alongside; move tests to
  the module that owns the code)
- `extensions/pr-autopilot/index.ts` (imports; cycles-count fix)

**Out of scope**:
- Any control-flow change in `runAutopilot`'s loop (verbatim move only)
- `github.ts`, `untrusted.ts`, `config.ts`, `agent-runner.ts`, prompts
- New features of any kind

## Git workflow

- Branch: `kstack/split-autopilot-driver`
- One commit per extracted module, each leaving the suite green.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Extract pure modules (verbatim moves)

In this order (each is import-only for the driver): `pr-state.ts`
(predicates), `tasks.ts` (prompt builders), `triage.ts` (parsing +
`applyForceAsk` + `classifyBlockers`), `persist.ts` (persisted state),
`git-mutation.ts` (`prepareMutationCheckout`, `doCommitAndPush`,
`restoreForbiddenPaths`, `runCleanup`, `applyThreadReplies` — it performs gh
mutations; put it here, not in triage). Re-export from `autopilot.ts` only if
`index.ts`/tests otherwise need broad import rewrites; prefer fixing imports.

**Verify after each move**: `npm run typecheck` exit 0;
`node --test extensions/pr-autopilot/*.test.ts` `fail 0`.

### Step 2: Unify runTriager/runFixer and drop the dead parameter

Replace both with one helper parameterized by role + tool grant (the only
differences: `tools` string and error-message prefix). Remove `pickModel`'s
unused `_role` parameter.

**Verify**: suite `fail 0`; `grep -n "_role" extensions/pr-autopilot` → none.

### Step 3: Split the test file

Move each test block next to its module (`pr-state.test.ts`,
`triage.test.ts`, etc.). Assertions unchanged.

**Verify**: `node --test extensions/pr-autopilot/*.test.ts` shows the same
total pass count as before Step 3.

### Step 4: Thread real cycle counts into the TUI card

In `index.ts`, widen `setPhase` to carry `cycles` and pass
`result.cyclesCompleted`-in-progress from the driver's `setPhase` calls
(the driver already has `cycle` in scope at every call site).

**Verify**: suite `fail 0`; manual: `grep -n "cycles" extensions/pr-autopilot/index.ts`
shows the value flowing from the callback, not a literal `0`.

## Test plan

- No new behavior → no new tests required, but add one driver-level test if
  cheap: `maxFixCycles` × mode table already tested? If not, add it to the
  driver's remaining test file.
- Gate: identical total pass count through Steps 1–3; +1 if the table test is
  added.

## Done criteria

- [ ] `npm run typecheck` exits 0; `npm test` `fail 0`
- [ ] `wc -l extensions/pr-autopilot/autopilot.ts` ≤ 550
- [ ] No module in `extensions/pr-autopilot/` exceeds 600 lines
- [ ] `grep -n "cycles: 0" extensions/pr-autopilot/index.ts` → no literal-zero phase cards
- [ ] `plans/README.md` status row updated

## STOP conditions

- A "verbatim move" turns out to require signature changes beyond imports
  (hidden coupling through closure state) — report which variable.
- Plan 006 has not landed and its edits collide with `persist.ts`/`pr-state.ts`
  extraction — land 006 first.

## Maintenance notes

- The land-workflow implementation (plans/land-workflow.md) should import
  merge-ready evidence from `pr-state.ts` rather than reaching into the
  driver.
- Reviewer: compare the driver's while-loop before/after with
  `git diff --color-moved=dimmed-zebra` — every line should be a move.

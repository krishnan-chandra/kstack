# Plan 008: Slim plan-implement/index.ts into phase modules

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat d0a9409..HEAD -- extensions/plan-implement/`
> Plans 003/004/005 are expected to have touched imports and the runner; if
> `index.ts`'s `runPreparedPlanImplement` has been materially restructured
> already, STOP — this plan may be moot.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED — this is the highest-value workflow in the repo; a botched
  refactor breaks the plan→implement→review→publish loop. Mitigation: pure
  extraction with no behavior change, gated by typecheck + full suite.
- **Depends on**: plans/003-typecheck-gate.md, plans/004-shared-child-agent-runner.md
- **Category**: tech-debt
- **Planned at**: commit `d0a9409`, 2026-08-14

## Why this matters

The repo's own ground rules
(`skills/create-pi-extension/references/ground-rules.md`) say: "Keep
`index.ts` focused on Pi registration and lifecycle adaptation… put
deterministic logic in named modules." `extensions/plan-implement/index.ts`
is 697 lines; `runPreparedPlanImplement` alone is ~380 lines containing a
~120-line nested closure (`runFixAndPublish`), mutable captured state
(`workflowCwd`, `workstreamCheckpoint`), temp-file management for three
different phases, and all confirm-dialog copy. Every phase change requires
editing inside a quadruply-nested closure, and none of the phase logic is
unit-testable (index.ts has only a thin `index.test.ts`). The workflow
skeleton (`workflow.ts`, `runWorkflow`) already exists and is tested — the
extraction has an established home.

## Current state

- `extensions/plan-implement/index.ts` — structure at `d0a9409`:
  - `checkBasicPreflights` (line ~112), `prepareTask` (~130)
  - `runPreparedPlanImplement` (~139–600): preflights → skills check →
    config/roles → stack/worktree preflight → confirm → `runFixAndPublish`
    closure (fixer + publisher phases, each with its own confirm, temp dir,
    postcondition checks) → main temp dir + `runWorkflow` invocation with
    inline `runPlanner`/`onPlan`/`approvePlan`/`runImplementer` closures
    (plan snapshot immutability check, ledger validation, worktree/branch
    creation) → panel-review request → fix/publish.
  - command registration (~610–690) with delivery-mode/change-kind selection.
- `workflow.ts` (`runWorkflow`) and `execution-ledger.ts`, `git-policy.ts`,
  `worktree.ts`, `command.ts`, `config.ts` are already extracted and tested —
  follow their style: pure functions + injected effects, colocated tests,
  no Pi imports in domain modules.
- The plan-snapshot invariant (approved plan chmod 0444 + content re-check
  before and after the implementer) and the ledger-for-review fallback are
  subtle and deliberate — preserve them exactly, with their comments.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `npm run typecheck` | exit 0 |
| Focused tests | `node --test extensions/plan-implement/*.test.ts` | `fail 0` |
| Full tests | `npm test` | `fail 0` |

## Scope

**In scope**:
- `extensions/plan-implement/index.ts`
- `extensions/plan-implement/phases.ts` (create) + `phases.test.ts` (create)
- `extensions/plan-implement/index.test.ts` (extend if entry points move)

**Out of scope**:
- Any user-visible string (confirm dialogs, notify messages) — byte-identical
- `workflow.ts`, `execution-ledger.ts`, `git-policy.ts`, `worktree.ts`,
  `config.ts`, `command.ts`, `api.ts`, prompts, playbooks
- Behavior changes of any kind (this is a pure extraction)

## Git workflow

- Branch: `kstack/slim-plan-implement-index`
- Commit per extraction step. Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Extract phase runners into phases.ts

Create `extensions/plan-implement/phases.ts` with pure(ish) functions that
take injected effects instead of closing over them. Suggested contract
(adjust names to repo taste, keep types strict):

```ts
export interface PhaseEffects {
	runAgent: typeof runAgent;            // from ./agent-runner.ts
	confirm(title: string, body: string): Promise<boolean>;
	notify(msg: string, level?: "info" | "warning" | "error"): void;
	setStatus(text: string | undefined): void;
	sendPhase(result: AgentRunResult): void;
	isCurrent(): boolean;                 // lifecycle token check
	beginChild(phase: string): AbortController | undefined;
	endChild(controller: AbortController): void;
}
export function runPlannerPhase(cfg: …, fx: PhaseEffects): Promise<AgentRunResult>;
export function runImplementerPhase(cfg: …, fx: PhaseEffects): Promise<AgentRunResult & { executionLedger?: string }>;
export function runFixPhase(cfg: …, fx: PhaseEffects): Promise<"completed" | "skipped" | "failed">;
export function runPublishPhase(cfg: …, fx: PhaseEffects): Promise<"completed" | "skipped" | "failed">;
```

Move into these functions, unchanged: the plan-snapshot immutability checks,
ledger creation/validation/fallback, worktree/branch creation calls, and the
postcondition (`verifyCommittedWorkstream`) calls. `index.ts` keeps: Pi
registration, lifecycle token plumbing, temp-dir creation/cleanup, and the
construction of `PhaseEffects` from `ctx`/`pi`.

Work incrementally: extract one phase per commit, keeping `index.ts` calling
the new function; never leave the file in a state where a phase exists in
both places.

**Verify after each phase extraction**: `npm run typecheck` exit 0 AND
`node --test extensions/plan-implement/*.test.ts` `fail 0`.

### Step 2: Add unit tests for the extracted phases

`phases.test.ts`: with a fake `runAgent` and recorded effects, cover at
minimum — plan rejected when ledger creation fails; implementer refused when
the plan file content changed (snapshot mismatch); implementer failure
propagates without offering publish; fixer postcondition failure blocks
publish; publisher confirm=false skips cleanly. Model fakes on
`workflow.test.ts`.

**Verify**: `node --test extensions/plan-implement/phases.test.ts` → `fail 0`,
≥5 new tests.

### Step 3: Confirm the size target and no string drift

**Verify**:
- `wc -l extensions/plan-implement/index.ts` → ≤ 350
- `git diff d0a9409..HEAD -- extensions/plan-implement | grep '^-.*confirm('`
  — every removed confirm string must reappear verbatim in phases.ts
  (spot-check the three dialogs; a helper script is fine).
- `npm test` → `fail 0`.

## Test plan

- New `phases.test.ts` (Step 2 list).
- Existing suites pass unchanged; total test count strictly increases.

## Done criteria

- [ ] `npm run typecheck` exits 0; `npm test` `fail 0`
- [ ] `extensions/plan-implement/index.ts` ≤ 350 lines
- [ ] `extensions/plan-implement/phases.ts` exists with ≥5 tests
- [ ] Confirm/notify strings byte-identical (spot-check documented in report)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Preserving the plan-snapshot invariant requires changing *when* the file is
  written or chmodded — that ordering is security-relevant; report instead.
- The extraction forces a change to `WorkflowLifecycle`'s public surface.
- Any existing test assertion must change.

## Maintenance notes

- Future phases (e.g. the land-workflow handoff in `plans/land-workflow.md`
  names plan-implement's publish phase as its integration point) should be
  added as new `phases.ts` functions, not new closures in index.ts.
- Reviewer: diff the phase functions against the old closures side-by-side;
  the risk is a dropped `isCurrent()` guard at an await boundary.

# Plan 004: Extract one shared child-agent runner from four drifted copies

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat d0a9409..HEAD -- extensions/plan-implement/agent-runner.ts extensions/pr-autopilot/agent-runner.ts extensions/panel-review/reviewer-runner.ts extensions/kstack-router/classifier-runner.ts extensions/shared/`
> Plan 003 may have touched types in these files; larger drift is a STOP.

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED — process lifecycle code; bugs show up as hangs or zombie
  children. Mitigated by the existing per-extension test suites (all four
  runners have colocated tests with fake spawn implementations).
- **Depends on**: plans/003-typecheck-gate.md
- **Category**: tech-debt
- **Planned at**: commit `d0a9409`, 2026-08-14

## Why this matters

Four extensions each carry a private copy of the same machinery: spawn
`pi --mode json -p --no-session`, parse the JSONL event stream, accumulate
usage, bound stdout/stderr, enforce idle/runtime timeouts, and kill the
process tree (SIGTERM → grace → SIGKILL):

- `extensions/plan-implement/agent-runner.ts` (318 lines)
- `extensions/pr-autopilot/agent-runner.ts` (325 lines)
- `extensions/panel-review/reviewer-runner.ts` (382 lines)
- `extensions/kstack-router/classifier-runner.ts` (304 lines)

They have **already drifted**, and the drift includes a real bug:

- `pr-autopilot/agent-runner.ts:150` computes
  `const stdoutLineCap = deps.stdoutLineCapBytes ?? LIMITS.stdoutLineBytes;`
  **and never uses it** — its `JsonLineParser` is constructed with no options,
  so oversized JSONL lines are silently discarded at the parser's 2 MB
  default. `plan-implement/agent-runner.ts` wires the same cap into
  `maxLineBytes`/`onOverflow` and kills the child as a protocol error.
- Timeout semantics differ silently: plan-implement's `timeoutMs` is a total
  cap with no idle reset; pr-autopilot and panel-review reset an idle timer on
  output *and* enforce a separate `maxRuntimeMs`; the classifier has a single
  timeout.
- `getPiInvocation` is byte-identical in all four; `SpawnedProcess`,
  `SpawnImpl`, `RunnerDeps`, truncation helpers, `killTree`/escalation, and
  usage accumulation are near-identical.

Every hardening fix currently must be made four times, and (as the stdout-cap
bug shows) isn't. The repo's own ground rules say extract shared code "after
concrete callers prove a stable contract" — four callers have.

## Current state

- `extensions/shared/` exists and already hosts cross-extension code
  (`pi-json-lines.ts`, `session-name.ts`) with colocated tests. Follow that
  pattern.
- What is genuinely per-extension and must stay in each extension:
  - argument building (`buildChildArgs` differs meaningfully: tools granted,
    skills re-added in stack mode, prompt files vs inline task, stdin piping
    for the classifier);
  - result post-processing (classifier envelope parsing, per-role output caps);
  - progress callback payloads (each has its own `onProgress` shape — unify on
    the superset `{ turns, activity?, preview? }`, which panel-review already
    uses).
- The classifier is the odd one out: it pipes the task over **stdin**
  (`classifier-runner.ts` gives `SpawnedProcess` an optional `stdin` and
  writes the task after spawn). The shared runner must support
  `stdin?: string`.
- All four have substantial colocated tests using injected `spawnImpl` fakes:
  `agent-runner.test.ts` (plan-implement 317 lines, pr-autopilot),
  `reviewer-runner.test.ts` (526 lines), `classifier-runner.test.ts`
  (262 lines). These tests define the behavioral contract — port assertions,
  do not weaken them.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `npm run typecheck` | exit 0 |
| Full tests | `npm test` | exit 0, `fail 0` |
| Focused | `node --test extensions/shared/*.test.ts` | `fail 0` |

## Scope

**In scope**:
- `extensions/shared/child-agent-runner.ts` (create)
- `extensions/shared/child-agent-runner.test.ts` (create)
- The four runner files above (shrink to thin adapters or delete if nothing
  extension-specific remains — keep the per-extension `buildChildArgs`)
- The four runners' test files (port/retarget)
- Call sites that import runner symbols (`plan-implement/index.ts`,
  `pr-autopilot/autopilot.ts`, `pr-autopilot/index.ts`,
  `panel-review/index.ts`, `kstack-router/index.ts`) — import-path changes
  only

**Out of scope**:
- Any change to child CLI flags, granted tools, prompts, or timeout *values*
- `extensions/shared/pi-json-lines.ts` (already shared; consume as is)
- Behavior changes beyond the two deliberate unifications named in Step 1

## Git workflow

- Branch: `kstack/shared-child-runner`
- Commit per step (shared module first, then one migration commit per
  extension). Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Design the shared contract (write it as types first)

Create `extensions/shared/child-agent-runner.ts` exporting:

```ts
export interface SpawnedProcess { /* superset: include optional stdin */ }
export type SpawnImpl = (command: string, args: string[], options: Record<string, unknown>) => SpawnedProcess;
export interface ChildRunnerDeps {
	spawnImpl?: SpawnImpl;
	piInvocation?: (args: string[]) => { command: string; args: string[] };
	killGraceMs?: number;
	/** Idle limit; any stdout/stderr output resets it. */
	idleTimeoutMs?: number;
	/** Absolute wall-clock ceiling. */
	maxRuntimeMs?: number;
	outputCapBytes?: number;
	stderrCapBytes?: number;
	stdoutLineCapBytes?: number;
}
export interface RunChildOptions {
	args: string[];              // built by the caller's buildChildArgs
	cwd: string;
	stdin?: string;              // classifier pipes the task
	signal?: AbortSignal;
	deps?: ChildRunnerDeps;
	onProgress?: (p: { turns: number; activity?: string; preview?: string }) => void;
}
export type ChildRunResult =
	| { status: "completed"; output: string; usage: ChildUsage }
	| { status: "failed"; error: string; usage: ChildUsage; stderr: string }
	| { status: "aborted"; usage: ChildUsage };
export function runChildAgent(options: RunChildOptions): Promise<ChildRunResult>;
export function getPiInvocation(args: string[]): { command: string; args: string[] };
export function truncateHeadUtf8(text: string, maxBytes: number, label?: string): string;
export function truncateTailUtf8(text: string, maxBytes: number): string;
```

Semantics (the two deliberate unifications — everything else preserves
current behavior):
1. **Idle + runtime timeouts everywhere.** `idleTimeoutMs` resets on any
   child output; `maxRuntimeMs` is absolute. Callers map their old knobs:
   plan-implement passes its old `timeoutMs` as `idleTimeoutMs` and its
   config has no runtime ceiling today — give it `maxRuntimeMs: idle × 3`
   and surface that in the failure message. (If this changes an existing
   plan-implement test's expectation, keep old semantics for plan-implement
   instead by passing `maxRuntimeMs: undefined` → no runtime timer. Choose
   whichever keeps its tests meaningful; document the choice in the module
   docstring.)
2. **Oversized JSONL lines are a protocol error for every caller** (the
   plan-implement behavior; fixes the pr-autopilot silent-discard bug).

Role/label decoration (`role`, `model`, per-role output caps) stays in thin
per-extension wrappers that call `runChildAgent` and re-wrap the result —
the existing public signatures of `runAgent`/`runReviewer`/`runClassifier`
should not change for their callers.

**Verify**: `npm run typecheck` → exit 0 (module compiles standalone;
wrappers not yet migrated).

### Step 2: Port the shared behavior tests

Create `child-agent-runner.test.ts` covering (port from the four suites):
completed with usage accumulation; failed on nonzero exit / stopReason error;
stderr capture and cap; abort → SIGTERM then SIGKILL after grace; idle
timeout kills a silent child; runtime ceiling kills a busy child; oversized
line → protocol error kill; empty output → failed; stdin piping; kill-tree
uses process-group signal off-Windows. Model the fake-spawn structure on
`extensions/panel-review/reviewer-runner.test.ts` (the most complete).

**Verify**: `node --test extensions/shared/child-agent-runner.test.ts` → `fail 0`.

### Step 3: Migrate one extension at a time, tests green between each

Order: panel-review (closest semantics) → pr-autopilot → kstack-router →
plan-implement (drifted semantics; handle the timeout decision from Step 1).
For each: rewrite its runner file as a thin wrapper (keep `buildChildArgs`
and the public `run*` signature), delete the duplicated internals, retarget
its runner tests at the wrapper (arg-building + result-mapping tests stay;
lifecycle tests move to the shared suite or assert through the wrapper).

**Verify after each extension**: `npm run typecheck` exit 0 AND
`node --test extensions/<name>/*.test.ts` `fail 0` AND `npm test` `fail 0`.

### Step 4: Confirm the duplication is gone

**Verify**:
`grep -rln "isBunVirtualScript" extensions/ | grep -v shared/` → no results
(the `getPiInvocation` copies are gone).
`grep -c "killTree" extensions/plan-implement/agent-runner.ts` → 0.

## Test plan

- New: `extensions/shared/child-agent-runner.test.ts` (Step 2 list).
- Existing four runner suites keep passing (retargeted, not weakened): the
  total `npm test` count must not decrease by more than the number of tests
  genuinely deduplicated into the shared suite; state the before/after counts
  in the final report.

## Done criteria

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 with `fail 0`
- [ ] `extensions/shared/child-agent-runner.ts` exists with tests
- [ ] No non-shared file defines `getPiInvocation` (grep above)
- [ ] Each of the four old runner files is < 150 lines or deleted
- [ ] `plans/README.md` status row updated

## STOP conditions

- A behavioral difference between the four runners beyond those documented
  here (idle-vs-total timeout, line-cap handling, stdin, per-role caps,
  progress shape) — report it before unifying over it.
- Any migrated extension's tests need assertions *weakened* to pass.
- plan-implement's timeout unification decision (Step 1.1) breaks more than
  2 of its existing tests either way — the semantics question needs a human.

## Maintenance notes

- Future subprocess hardening (e.g. env scrubbing, cgroup limits) now lands
  in one file. pr-autopilot's plan 009 and plan-implement's plan 008 assume
  this module exists.
- Reviewer should scrutinize: kill-path idempotency (double-kill on
  abort+timeout), and that no caller lost its `maxRuntimeMs` ceiling.

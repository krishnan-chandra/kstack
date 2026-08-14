# Plan 015: Extract panel-review's run pipeline into testable phase modules

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 7e18fff..HEAD -- extensions/panel-review/`
> Plan 012 may have rewritten `lifecycle.ts` internals (public API unchanged);
> that is expected. Material drift in `index.ts` is a STOP.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: MED — this path produces the verdict plan-implement consumes;
  a regression breaks two workflows. Mitigation: pure extraction with
  byte-identical strings, plus new unit tests on the resolution logic.
- **Depends on**: plans/012-shared-session-lifecycle.md (soft — same
  extension churn), plans/007 (DONE — the lifecycle guard this preserves)
- **Category**: tech-debt
- **Planned at**: commit `7e18fff`, 2026-08-14

## Why this matters

`extensions/panel-review/index.ts` is 461 lines; `runPanelReview`
(lines 111–~430) is a ~320-line closure mixing: lifecycle/session guards,
git scope resolution, intent intake, config + reviewer + synthesis model
resolution (with subtle fallback rules), the confirm dialog, dashboard
wiring, the panel fan-out, synthesis, verdict-card rendering, and temp-file
cleanup. The model-resolution fallback logic in particular — synthesis
required-in-config vs default-panel fallback-to-first-reviewer, warnings
passthrough, auth-gated `find` — is pure decision code that is untestable in
place and currently verified only end-to-end. plan-implement got exactly
this treatment in plan 008 (`phases.ts`, index 697→191 lines); panel-review
is the last workflow extension whose `index.ts` violates the repo ground
rule ("keep index.ts focused on Pi registration; put deterministic logic in
named modules").

## Current state

- `extensions/panel-review/index.ts` at `7e18fff`:
  - `:111` `runPanelReview` closure; guards (`isLive`, session token,
    `isRunning` rejection) at `:112–131`; scope/base at `:134–147`; intent
    editor at `:149–161`; config + `resolveReviewers` +
    `resolveSynthesisModel` with the fallback-to-first-reviewer rule at
    `:164–…`; `beginRun` at `:244` (post-confirm); dashboard + fan-out +
    synthesis + verdict from there; `endRun` in the finally at `:426`.
  - `session_start`/`session_shutdown` wiring at `:446–451`.
- The exemplar to follow: `extensions/plan-implement/phases.ts` (276 lines)
  with `PhaseEffects` (injected narrow functions) and
  `extensions/plan-implement/index.ts` (191 lines) as the thin adapter;
  tests in `phases.test.ts` use scripted effects.
- Already-extracted panel-review modules the new code must compose, not
  duplicate: `review-scope.ts` (collectScope/resolveBase/requireWorkTree),
  `config.ts` (loadConfig/resolveReviewers/resolveSynthesisModel),
  `orchestrator.ts` (runPanel), `reviewer-runner.ts` (runReviewer),
  `synthesis.ts` (buildSynthesisInput/Prompt, renderRawReports),
  `live-dashboard.ts`, `lifecycle.ts`.
- Strings that must stay byte-identical: every `notify` message, the confirm
  dialog title/body (including the thermo-nuclear lens line and the
  context-files warning), the editor title
  `"Panel review intent (required):"`, and the verdict card content —
  plan-implement's flow and users' muscle memory depend on them.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `npm run typecheck` | exit 0 |
| Focused | `node --test extensions/panel-review/*.test.ts` | `fail 0` |
| Full | `npm test` | `fail 0` |

## Scope

**In scope**:
- `extensions/panel-review/index.ts`
- `extensions/panel-review/run-phases.ts` (create) + `run-phases.test.ts` (create)

**Out of scope**:
- All already-extracted modules listed above (compose them unchanged)
- `api.ts` request contract and `PanelReviewOutcome` union
- Any user-visible string; any timeout/limit value
- The lifecycle guard semantics from plan 007

## Git workflow

- Branch: `kstack/panel-review-run-phases`
- Commit per extracted phase. Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Extract model/panel resolution (the pure part first)

Into `run-phases.ts`:

```ts
export interface PanelResolution {
	reviewers: ReviewerSpec[];
	maxConcurrency: number;
	warnings: string[];
	synthesis: { model: string; thinking?: string; cliId: string };
	timeoutMinutes: number;
	maxRuntimeMinutes: number;
}
export function resolvePanel(
	configLoad: ConfigLoad,
	modelDeps: ResolveDeps,
): { ok: true; resolution: PanelResolution } | { ok: false; error: string; warnings: string[] };
```

Move the logic from index.ts verbatim: invalid-config error; reviewer
resolution; synthesis resolution with the two-branch fallback (config loaded
→ synthesis error is fatal; no config → warn and fall back to
`reviewers[0]`); warnings accumulation; timeout defaults
(`DEFAULT_TIMEOUT_MINUTES`/`DEFAULT_MAX_RUNTIME_MINUTES`). The caller emits
the warnings — keep emission order identical.

**Verify**: `npm run typecheck` exit 0; new unit tests below pass.

### Step 2: Unit-test resolvePanel (≥6 cases)

`run-phases.test.ts` with fake `ResolveDeps` (model on
`extensions/panel-review/config.test.ts` fakes):
1. invalid config → fatal error string unchanged;
2. loaded config, synthesis resolution fails → fatal (error passthrough);
3. no config, synthesis default unavailable → warning + fallback to first
   reviewer, `cliId` without thinking suffix;
4. synthesis with thinking → `cliId` = `model:thinking`;
5. reviewer warnings passed through in order;
6. timeouts: loaded config values vs defaults.

**Verify**: `node --test extensions/panel-review/run-phases.test.ts` →
`fail 0`, ≥6 tests.

### Step 3: Extract the execution pipeline behind narrow effects

Add to `run-phases.ts` a `runReviewPipeline(input, fx)` that owns: prompt
temp-dir creation, reviewer prompt assembly (move `assembleReviewerPrompt`),
the fan-out via `runPanel`+`runReviewer`, synthesis invocation, and raw-report
fallback — taking `fx` for `notify/setCompactStatus/confirm/dashboard`
callbacks and `isCurrent()` guards, mirroring `PhaseEffects` in
`extensions/plan-implement/phases.ts`. `index.ts` keeps: registration,
lifecycle token minting, scope collection + no-changes check + confirm (they
need `ctx` UI directly), verdict `pi.sendMessage`, and cleanup of
`scope.dir` (pipeline cleans only its own promptDir — preserve today's
split of cleanup responsibilities exactly; read the current `finally` block
first).

Work incrementally; suite green after each move.

**Verify after each move**: `npm run typecheck` exit 0;
`node --test extensions/panel-review/*.test.ts` `fail 0`.

### Step 4: Size and string checks

**Verify**:
- `wc -l extensions/panel-review/index.ts` ≤ 260;
- every removed notify/confirm string reappears verbatim in `run-phases.ts`
  (spot-check the confirm body and the synthesis-failure warning);
- `npm test` → `fail 0`.

## Test plan

- New `run-phases.test.ts`: Step 2 cases, plus (if cheap with scripted
  effects) one pipeline case: all reviewers fail → error includes the
  per-reviewer diagnostic lines; synthesis failure → raw-reports fallback
  with `synthesized: false`.
- Existing suites unchanged.

## Done criteria

- [ ] `npm run typecheck` exits 0; `npm test` exits 0 with `fail 0`
- [ ] `extensions/panel-review/run-phases.ts` exists; ≥6 new tests pass
- [ ] `wc -l extensions/panel-review/index.ts` ≤ 260
- [ ] `PanelReviewOutcome` union unchanged (`git diff -- extensions/panel-review/types.ts` empty)
- [ ] plan-implement suite untouched and green (it consumes the verdict path)
- [ ] `plans/README.md` status row updated

## STOP conditions

- The cleanup-responsibility split (scope.dir vs promptDir) cannot be
  preserved without behavior change — report; do not consolidate cleanup as
  a side effect of this plan.
- Extracting the pipeline requires passing `ctx` or `pi` into
  `run-phases.ts` — narrow the effects instead; if impossible, report.
- Any existing test assertion must change.

## Maintenance notes

- After this, all four workflow extensions follow the same shape: thin
  index.ts + phases/operations module + lifecycle + runner. Future reviewers
  should reject new logic added directly to any index.ts.
- Reviewer: diff with `--color-moved=dimmed-zebra`; scrutinize `isLive()`
  guard coverage at every await inside the pipeline (same risk as plan 008).

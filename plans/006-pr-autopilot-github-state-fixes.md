# Plan 006: Fix pr-autopilot GitHub state-reading bugs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat d0a9409..HEAD -- extensions/pr-autopilot/`
> Plan 003 may have added a `UsageSummary` type to `types.ts`; other drift in
> `github.ts`/`autopilot.ts` requires re-verifying the excerpts below.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED — changes what the autopilot believes about a PR; wrong fixes
  could make it act on stale threads or treat red CI as green. Every change
  below is covered by a new unit test against recorded `gh` output shapes.
- **Depends on**: none (composes with 003; rebase trivially either order)
- **Category**: bug
- **Planned at**: commit `d0a9409`, 2026-08-14

## Why this matters

Four independent defects in how pr-autopilot reads and persists PR state:

1. **Persisted state collides across repositories.** State is keyed by PR
   number only, in the shared temp dir. Repo A's PR #5 and repo B's PR #5
   share one file — `handledThreadIds` from one repo can silently hide
   *unresolved* threads in another, and `flakeRetried`/`repliedThreadIds`
   leak the same way.
2. **Cancelled checks count as green.** `parseCheckState` maps
   `cancel`/`cancelled` to `"neutral"`, and `checksGreen` treats `neutral` as
   success. A cancelled required build can make `isCodeReady` true; the
   autopilot then reports "code-ready" without any CI having run.
3. **Issue comments are silently truncated to the first page.**
   `getIssueComments` calls the REST endpoint without pagination — 30
   comments max, oldest first. On a busy PR, the newest human feedback is
   exactly what gets dropped.
4. **Dead exports.** `checkConflicts`, `checkStaleBase`, and `postPRComment`
   in `github.ts` have no callers outside tests.

## Current state

- `extensions/pr-autopilot/autopilot.ts:299`:

```ts
function persistPath(prNumber: number): string {
	return join(tmpdir(), `pi-pr-autopilot-state-${prNumber}.json`);
}
```

  Loaded/saved by `loadPersistedState`/`savePersistedState` just below it;
  both take only `prNumber` today. Call sites inside `runAutopilot` (~6) all
  have `cwd` in scope.

- `extensions/pr-autopilot/github.ts:467`:

```ts
function parseCheckState(state: string | undefined, bucket: string | undefined): CheckRun["status"] {
	const token = (bucket ?? state ?? "pending").toLowerCase();
	if (token === "pass" || token === "success") return "success";
	if (token === "fail" || token === "failure" || token === "error") return "failure";
	if (token === "skipping" || token === "skipped") return "skipped";
	if (token === "cancel" || token === "cancelled" || token === "neutral") return "neutral";
	return "pending";
}
```

  And in `autopilot.ts` (`checksGreen`, ~line 118):
  `return c.conclusion === "success" || c.conclusion === "skipped" || c.conclusion === "neutral";`

- `extensions/pr-autopilot/github.ts:438`:

```ts
	const result = await gh(exec, cwd, [
		"api",
		`repos/{owner}/{repo}/issues/${prNumber}/comments`,
		"--method", "GET",
	]);
```

- `CheckRun["status"]` union lives in `extensions/pr-autopilot/types.ts:39`
  (interface `CheckRun`).
- Test conventions: pure parsers tested with literal JSON strings in
  `github.test.ts`; state-machine behavior tested in `autopilot.test.ts` with
  fake `ExecFn`s. Match them.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | `node --test extensions/pr-autopilot/*.test.ts` | `fail 0` |
| Typecheck (if plan 003 landed) | `npm run typecheck` | exit 0 |
| Full tests | `npm test` (or per-directory commands) | `fail 0` |

## Scope

**In scope**:
- `extensions/pr-autopilot/autopilot.ts`
- `extensions/pr-autopilot/github.ts`
- `extensions/pr-autopilot/types.ts` (only if a status union must grow)
- `extensions/pr-autopilot/autopilot.test.ts`, `github.test.ts`

**Out of scope**:
- `untrusted.ts`, `config.ts`, `agent-runner.ts`, prompts
- Changing the "watch CI instead of inventing work" loop policy
- `isForbiddenStagingPath` (recorded separately as a known limitation)

## Git workflow

- Branch: `kstack/pr-autopilot-state-fixes`
- One commit per numbered fix. Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Scope persisted state to the repository

Change `persistPath(prNumber)` to `persistPath(repoKey, prNumber)` where
`repoKey = createHash("sha256").update(<canonical repo identity>).digest("hex").slice(0, 12)`.
Use the repo's `nameWithOwner` when cheaply available, else the canonical
`cwd`; simplest correct option: derive from `cwd` via
`realpathSync` inside the existing call path — `runAutopilot` receives `cwd`
and can compute the key once. Thread the key through
`loadPersistedState`/`savePersistedState` (both currently take/carry
`prNumber` only; `AutopilotPersistedState` in `types.ts:131` may gain a
`repoKey` field for self-description).

Old state files (`pi-pr-autopilot-state-<n>.json`) are simply orphaned in the
temp dir; do not migrate them.

**Verify**: new tests in `autopilot.test.ts`: (a) two different repo keys with
the same PR number produce different paths; (b) round-trip save/load
preserves `handledThreadIds`. `node --test extensions/pr-autopilot/autopilot.test.ts` → `fail 0`.

### Step 2: Stop counting cancelled checks as green

Introduce a distinct `"cancelled"` member in `CheckRun["status"]`
(types.ts:39) and map `cancel`/`cancelled` to it in `parseCheckState`
(keep genuine `neutral` → `neutral`). In `autopilot.ts`:
- `checksGreen`: `cancelled` is **not** green.
- `hasFailingChecks`: treat `cancelled` like a failure for actionability
  (triager sees it and can classify flake/infra/code), OR add it to the
  pending/blocked path — decide by reading `describeBlockers` and keeping its
  output truthful (a cancelled check must appear in the blocker string).
  Prefer: failure-like, so the existing flake-retrigger path can rerun it.

**Verify**: new `github.test.ts` case: `gh pr checks` JSON row with
`"bucket":"cancel"` parses to `status: "cancelled"`, `conclusion` non-null.
New `autopilot.test.ts` case: a state whose only non-success check is
cancelled → `isCodeReady` false and `describeBlockers` mentions it.
`node --test extensions/pr-autopilot/*.test.ts` → `fail 0`.

### Step 3: Paginate issue comments

Add `--paginate` to the `gh api` call in `getIssueComments` and cap client-side
(e.g. keep the **most recent** `LIMITS`-appropriate number, ~100, after
filtering autopilot replies) so a pathological PR cannot flood the triager.
Note: with `--paginate`, `gh` concatenates JSON arrays; pass `--slurp` if
available (gh ≥ 2.31 emits an array of arrays with `--slurp`; without it,
concatenated arrays are invalid JSON). Detect the shape in
`parseIssueComments`: accept either a flat array or an array of arrays and
flatten. Write the parser first, against both literal shapes.

**Verify**: `github.test.ts`: parser accepts `[[{...}],[{...}]]` (slurped) and
flat `[{...}]`, filters `<!-- pr-autopilot -->` replies, and truncates to the
newest N with a deterministic rule. `node --test extensions/pr-autopilot/github.test.ts` → `fail 0`.

### Step 4: Remove dead exports

Delete `checkConflicts`, `checkStaleBase`, `postPRComment` from `github.ts`
and their tests. Confirm no callers:
`grep -rn "checkConflicts\|checkStaleBase\|postPRComment" extensions/ --include="*.ts"` → only the definitions you are deleting.

**Verify**: full pr-autopilot suite `fail 0`; grep returns nothing after.

## Test plan

- New tests named in Steps 1–3 (persisted-state scoping ×2, cancelled-check
  parsing + readiness ×2, pagination parsing ×3).
- Pattern: model after existing `parsePrChecksJson` and `buildPRState` tests
  in the same files.
- Verification: `node --test extensions/pr-autopilot/*.test.ts` → all pass
  including ≥7 new tests.

## Done criteria

- [ ] `node --test extensions/pr-autopilot/*.test.ts` exits 0, `fail 0`, ≥7 new tests
- [ ] `grep -n "state-\${prNumber}" extensions/pr-autopilot/autopilot.ts` → no match (path now includes a repo key)
- [ ] `grep -n '"cancel"' extensions/pr-autopilot/github.ts` shows mapping to `"cancelled"`, not `"neutral"`
- [ ] `grep -rn "checkStaleBase" extensions/` → no results
- [ ] If plan 003 landed: `npm run typecheck` exits 0
- [ ] `plans/README.md` status row updated

## STOP conditions

- The installed `gh` version's `--paginate` output shape differs from both
  shapes handled in Step 3 (verify once with a real `gh api ... --paginate`
  against any public repo if network access is permitted; otherwise trust the
  dual-shape parser and say so in the report).
- Making `cancelled` failure-like causes the drive loop to hard-loop on a
  check that can never be rerun (no `runId`) — report; the blocked-path
  mapping may be the right call instead.
- Any existing test's assertion needs weakening.

## Maintenance notes

- The future land-workflow (plans/land-workflow.md) consumes
  `isMergeReady`/`describeBlockers` as its evidence source — Step 2's
  truthfulness matters beyond this extension.
- Reviewer: scrutinize the recency-truncation rule in Step 3 (newest-N must
  not reorder threads relative to `filterHandledThreads` expectations).

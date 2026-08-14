# Plan 003: Add a typecheck gate and fix all type errors in extensions/

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat d0a9409..HEAD -- extensions package.json .github/workflows/ci.yml`
> Plans 001/002 are expected to have changed `archive-store.ts`, `package.json`,
> and `ci.yml`. Any *other* drifted file in `extensions/`: compare the
> "Known real defects" list below against live code before fixing.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED — type-error fixes can change runtime behavior if done
  carelessly; the rules below keep fixes behavior-preserving.
- **Depends on**: plans/002-package-json-and-ci.md
- **Category**: tech-debt / bug
- **Planned at**: commit `d0a9409`, 2026-08-14

## Why this matters

The extensions are TypeScript executed by Node's type stripping — **types are
never checked by anything**. A full `tsc --noEmit` run at commit `d0a9409`
produced **110 errors**, including genuinely broken code that only "works"
because annotations are erased:

- `extensions/plan-implement/index.ts` uses `ExtensionCommandContext` at lines
  112, 139, 614 **without importing it** (TS2304).
- `extensions/pr-autopilot/agent-runner.ts:18` and `autopilot.ts:46` import
  `UsageSummary` from `./types.ts`, **which does not define it** (TS2305).
- `extensions/panel-review/types.ts`'s `ReviewerResult` has no `usage`
  property, yet `panel-review/index.ts:286,342` read `result.usage` — the
  runtime value exists (reviewer-runner returns it); the declared type lies.
- `extensions/panel-review/index.ts:28` imports `ScopeBundle` from
  `./review-scope.ts`, which only re-uses it from `./types.ts` without
  re-exporting (TS2459).
- `extensions/plan-implement/api.ts:86` calls `isChangeKind(changeKind)` where
  `changeKind: ChangeKind | ExtensionCommandContext` (TS2345) — an object can
  reach a string predicate.

Until a gate exists, every refactor (plans 004, 005, 008, 009) is flying
blind. This plan creates the gate and drives the error count to zero.

## Current state

- Root `package.json` exists (plan 002) with `"type": "module"`, no deps.
- Pi's packages are installed globally on the authoring machine at
  `~/.bun/install/global/node_modules/@earendil-works/*`; the repo itself has
  no node_modules. For a reproducible typecheck the repo needs
  devDependencies (they do **not** affect runtime — Pi loads extensions with
  its own module resolution).
- The full error list can be regenerated at any time; do that rather than
  trusting the snapshot: see Step 2.
- Error distribution at `d0a9409` (source files, excluding config artifacts):
  `handoff/index.test.ts` 44, `kstack-router/index.ts` 10 (8 real),
  `handoff/index.ts` 8, `panel-review/index.ts` 7,
  `session-archive/session-picker.test.ts` 5, `plan-implement/index.ts` 4,
  `pr-autopilot` 6, `panel-review/config.test.ts` 4, plus singletons.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install dev deps | `npm install` | exit 0, lockfile created |
| Typecheck | `npm run typecheck` | exit 0, no output |
| Tests | `npm test` | exit 0, `fail 0` |

## Scope

**In scope**:
- `package.json` (add devDependencies + `typecheck` script), `package-lock.json`
- `tsconfig.json` (create)
- `.github/workflows/ci.yml` (add `npm ci` + `npm run typecheck`)
- Type-error fixes in any `extensions/**/*.ts` file
- `README.md` Development section (mention `npm run typecheck`)

**Out of scope**:
- `skills/**` (plain .mjs, not typechecked)
- `install.mjs` / `install.test.mjs`
- Any *behavioral* change beyond what a type fix strictly requires
- Renaming/moving files (that is plans 004/008/009)

## Git workflow

- Branch: `kstack/typecheck-gate`
- Commit per logical unit: (1) tooling, (2) one commit per extension's fixes.
  Message style: imperative, e.g. `Fix pr-autopilot type errors`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Tooling

Add to `package.json` devDependencies (match the versions Pi itself uses when
resolvable; otherwise latest): `typescript`, `@types/node`,
`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
`@earendil-works/pi-ai`, `typebox`. Add script
`"typecheck": "tsc -p tsconfig.json"`.

Create `tsconfig.json`:

```json
{
	"compilerOptions": {
		"noEmit": true,
		"strict": true,
		"target": "es2023",
		"module": "nodenext",
		"moduleResolution": "nodenext",
		"allowImportingTsExtensions": true,
		"rewriteRelativeImportExtensions": false,
		"skipLibCheck": true,
		"lib": ["es2023"],
		"types": ["node"]
	},
	"include": ["extensions/**/*.ts"]
}
```

If `tsc` reports unknown option `rewriteRelativeImportExtensions`, drop it.

**Verify**: `npm install && npm run typecheck 2>&1 | tail -3` → runs and
reports errors (a number, not a crash). `import.meta`-related TS1470 errors
must be gone (the root `"type": "module"` handles them); if any remain, fix
the tsconfig before proceeding.

### Step 2: Generate the authoritative error list

`npm run typecheck 2>&1 | grep "error TS" | sort > /tmp/ts-errors.txt` and
work from that file, not from this plan's snapshot.

**Verify**: `wc -l /tmp/ts-errors.txt` → roughly 90–115 lines.

### Step 3: Fix the known real defects first (behavior-preserving)

Fix rules, in priority order: (a) add the missing import/export/type,
(b) correct the type to match verified runtime behavior, (c) narrow with a
type guard. Never delete a runtime check to satisfy the compiler; never add
`any`; use `as` only at test-fixture boundaries.

1. `plan-implement/index.ts` — add `ExtensionCommandContext` to the existing
   `import type { ExtensionAPI, Skill }` from `@earendil-works/pi-coding-agent`.
2. `pr-autopilot/types.ts` — define and export `UsageSummary` (shape:
   `{ input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number }`,
   exactly what `emptyUsage()` in `autopilot.ts:80` constructs).
3. `panel-review/types.ts` — add `usage?: UsageSummary` (and `activity?: string`
   if reported) to the failed/completed `ReviewerResult` variants so
   `index.ts:286,342` and `orchestrator.ts:55` typecheck against the values
   `reviewer-runner.ts` actually returns. Read reviewer-runner's `finalize`
   calls to get the exact shape; make the type match reality, not vice versa.
4. `panel-review/review-scope.ts` — re-export: `export type { ScopeBundle } from "./types.ts";`
   (or change `index.ts` to import it from `./types.ts`; pick one, apply once).
5. `plan-implement/api.ts:86` — guard: `typeof changeKind === "string" && isChangeKind(changeKind)`.
6. `kstack-router/index.ts:112–119` — `message.content` is
   `string | (TextContent | ImageContent)[]`; render via a small helper that
   returns `typeof content === "string" ? content : "(structured content)"`
   (do not stringify parts arrays into the TUI).
7. `kstack-router/config.ts:36` — the union return includes an object literal
   with an extra `config` property on the error branch; restructure the return
   so each branch matches its variant exactly.
8. `session-archive/index.ts:272,331` — the two tool `execute` handlers must
   return `details` (the registered-tool result type requires it). Return
   `details: {}` or a meaningful `{ sessionId }` like handoff's tools do
   (see `extensions/handoff/index.ts` execute handlers for the pattern).
9. `handoff/index.ts` and `history-reader.ts:251` — align `HandoffModel` with
   Pi's `Model` type (prefer importing Pi's type or a structural subset;
   remove the `as` casts at lines 89/366 where a guard can replace them) and
   reconcile `null` vs `undefined` in the entry-view types (pick the shape the
   formatter accepts, `string | null | undefined` is acceptable).

**Verify** after each numbered item: `npm run typecheck 2>&1 | grep -c "error TS"`
strictly decreases, and `npm test` still reports `fail 0`.

### Step 4: Fix the remaining errors (mostly tests)

Test-file errors (e.g. `handoff/index.test.ts` 44 errors, readonly-array
mismatches in `pr-autopilot/autopilot.test.ts:203-206`, incomplete fixtures in
`session-archive/session-picker.test.ts`) are fixture-shape problems:
complete the fixture objects, accept `readonly` parameters in the tested
function signatures where the function does not mutate (e.g. `pickModel`
in `autopilot.ts` can take `readonly AutopilotModelSpec[]`), or cast a
deliberately-partial fake via a single `as unknown as T` with a comment.

`panel-review/scripts/panel-review-dashboard-e2e.ts` (8 errors): if the fixes
are not obvious, exclude `extensions/*/scripts/**` in tsconfig `exclude` and
note it — scripts are manual harnesses, not shipped code.

**Verify**: `npm run typecheck` → exit 0, zero errors.

### Step 5: Wire CI

In `.github/workflows/ci.yml` add before the test step:
`- run: npm ci` and `- run: npm run typecheck`.

**Verify**: file contains all three run steps in order (ci, typecheck, test).

## Test plan

No new tests. Gate: `npm test` must report the same pass count before and
after each commit (type fixes must not change behavior). If a type fix
*reveals* a real bug whose fix would change behavior, STOP and report it —
do not fix it silently inside this plan.

## Done criteria

- [ ] `npm run typecheck` exits 0
- [ ] `npm test` exits 0 with `fail 0`
- [ ] `grep -rn "ExtensionCommandContext" extensions/plan-implement/index.ts | head -1` shows it in an import line
- [ ] `grep -n "UsageSummary" extensions/pr-autopilot/types.ts` shows an exported definition
- [ ] ci.yml runs `npm ci`, `npm run typecheck`, `npm test`
- [ ] `plans/README.md` status row updated

## STOP conditions

- The installed `@earendil-works/pi-coding-agent` types disagree with runtime
  behavior the tests depend on (e.g. tool `details` truly optional at runtime
  but required in types) **and** matching the types would break a test —
  report the conflict; version pinning may be needed.
- Zero-error state requires more than ~5 `as unknown as` casts in non-test
  code — the plan's premise (mostly mechanical fixes) is wrong; report.
- `npm test` pass count changes at any step.

## Maintenance notes

- Plans 004/005/008/009 assume this gate exists; they will extend tsconfig
  coverage automatically since it includes all of `extensions/`.
- Reviewers: scrutinize every fix in `panel-review/types.ts` and
  `pr-autopilot/types.ts` against what the runners actually return — the
  point is to make types match verified runtime shapes, not to silence tsc.
- Follow-up explicitly deferred: enabling `noUncheckedIndexedAccess` (larger
  sweep, real value; consider after 004/005).

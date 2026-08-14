# Plan 002: Add a root package.json and test scripts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat d0a9409..HEAD -- package.json .github README.md`
> If `package.json` or `.github/` already exist, treat it as a STOP condition
> (someone did this work already); a README change alone is fine — re-read the
> Development section before editing it.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-fix-archive-schema-race.md (CI must start green)
- **Category**: dx
- **Planned at**: commit `d0a9409`, 2026-08-14

## Why this matters

The repository has **no package.json, no lockfile, and no one-command
way to know the codebase works**. The canonical test invocation is a 14-line
copy-paste block in README.md ("Development" section, lines ~250–270). As a
result a test has been failing on `main` without anyone noticing (fixed by
plan 001). Every subsequent plan in this directory names verification
commands; this plan makes them one command.

## Current state

- Repo root contains no `package.json` or `tsconfig.json`
  (verified at commit `d0a9409`).
- Tests are plain `node --test` files: `extensions/*/*.test.ts`,
  `skills/*/*.test.mjs`, `skills/investigation-model.test.mjs`,
  `install.test.mjs`. Node 22+ runs `.ts` directly (type stripping); the
  authoring machine runs Node 26.
- `.gitignore` already ignores `node_modules/`, `coverage/`, `plans/`.
- Extensions import `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`,
  `@earendil-works/pi-ai`, and `typebox` — resolved at *runtime* by Pi's own
  installation, not by this repo. Unit tests deliberately avoid importing Pi
  (only some entry-point tests do; check whether `node --test` currently
  passes without node_modules — it does on the authoring machine because the
  heavier index tests use mocks; do not change that property).
- README.md "Development" section lists the per-directory test commands; keep
  it but lead with the new single command.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Full suite (after this plan) | `npm test` | exit 0, `fail 0` |
| Spot check | `node --test extensions/shared/*.test.ts` | exit 0 |

## Scope

**In scope**:
- `package.json` (create)
- `README.md` (Development section only)

**Out of scope**:
- `tsconfig.json` and any devDependencies — that is plan 003.
- `install.mjs` / `install.test.mjs` behavior.
- Any file under `extensions/` or `skills/`.

## Git workflow

- Branch: `kstack/root-package-test-scripts`
- One commit, e.g. `Add root package.json test scripts`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create package.json

Create `/package.json`:

```json
{
	"name": "kstack",
	"private": true,
	"type": "module",
	"engines": { "node": ">=22" },
	"scripts": {
		"test": "node --test install.test.mjs \"extensions/**/*.test.ts\" \"skills/**/*.test.mjs\" skills/investigation-model.test.mjs",
		"test:extensions": "node --test \"extensions/**/*.test.ts\""
	}
}
```

Notes:
- `"type": "module"` matters: every `.mjs`/`.ts` file here uses ESM and
  `import.meta`; plan 003's typechecker also keys off this.
- Node's test runner accepts glob patterns since Node 21; quote them so the
  shell does not expand.
- If `skills/investigation-model.test.mjs` is already matched by
  `skills/**/*.test.mjs`, drop the explicit entry (check with
  `node --test --test-reporter=dot "skills/**/*.test.mjs"` listing).

**Verify**: `npm test` → exits 0, reporter shows the same total count as the
per-directory commands combined (expect ≈580+ tests, `fail 0`).

### Step 2: Update README

In README.md's Development section, put `npm test` first and keep the
per-directory `node --test` commands as the focused alternative.

**Verify**: `grep -n "npm test" README.md` → at least one hit in the
Development section.

## Test plan

No new tests. The deliverable *is* the test entry point.
`npm test` must produce `fail 0` — if it does not, plan 001 has not landed;
STOP.

## Done criteria

- [ ] `npm test` exits 0 with `fail 0`
- [ ] `git status` shows only `package.json`, `README.md`
- [ ] `plans/README.md` status row updated

## STOP conditions

- A `package.json` already exists.
- `npm test` fails because of the archive-store concurrency test — plan 001
  must land first.
- The glob form of `node --test` collects a different test count than the
  README's per-directory commands — reconcile the globs, and if any test file
  is unreachable by glob, report it instead of silently narrowing coverage.

## Maintenance notes

- Plan 003 extends this package.json with devDependencies and a
  `typecheck` script.

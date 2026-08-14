# Plan 001: Fix the cross-process schema-initialization race in session-archive

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat d0a9409..HEAD -- extensions/session-archive/archive-store.ts extensions/session-archive/archive-store.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `d0a9409`, 2026-08-14

## Why this matters

`openArchiveDb` initializes the SQLite schema with a check-then-act sequence
that is not atomic across processes. Two Pi processes that open the archive
database concurrently (for example two Pi sessions starting at the same time —
`session_start` reconciliation in `extensions/session-archive/index.ts` calls
`openArchiveDb` on every startup) can both observe `user_version == 0`; the
second then executes `CREATE TABLE` after the first committed and crashes with
`table archive_sessions already exists`. The repository's own test suite proves
this: one test currently **fails** on a clean checkout, which also blocks
plan 002 (green CI baseline).

## Current state

- `extensions/session-archive/archive-store.ts` — SQLite catalog. `openArchiveDb`
  (line ~71) sets `PRAGMA busy_timeout=5000` and WAL, then calls
  `initializeSchema`.
- `initializeSchema` (lines 111–130) reads the version **before** taking the
  write lock:

```ts
// archive-store.ts:111
function initializeSchema(db: DatabaseSync): void {
	const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
	if (row.user_version === SCHEMA_VERSION) return;
	if (row.user_version !== 0) {
		throw new ArchiveStoreError(
			`unsupported archive schema version ${row.user_version} (expected ${SCHEMA_VERSION})`,
		);
	}
	db.exec("BEGIN IMMEDIATE");
	try {
		db.exec(SCHEMA_SQL);
		db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}
```

The race: process A and process B both read `user_version == 0`. A acquires
`BEGIN IMMEDIATE`, creates the schema, commits (`user_version` is now 1).
B, which was blocked on `BEGIN IMMEDIATE` by the busy timeout, acquires the
lock and runs `SCHEMA_SQL` — `CREATE TABLE archive_sessions` throws.

- The failing test is `extensions/session-archive/archive-store.test.ts:349`
  ("serializes concurrent imports from two processes without duplicates"). It
  spawns two real child processes against one database file. Do not weaken or
  delete this test — it is the regression proof.
- Repo conventions: plain `node --test`, no framework; error type is
  `ArchiveStoreError`; transactions use explicit `BEGIN IMMEDIATE`/`COMMIT`/
  `ROLLBACK` via `db.exec`. Match this style.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | `node --test extensions/session-archive/archive-store.test.ts` | all pass, 0 fail |
| Extension tests | `node --test extensions/session-archive/*.test.ts` | all pass, 0 fail |

(Node 22+ required; the machine this plan was written on runs Node 26.)

## Scope

**In scope** (the only files you should modify):
- `extensions/session-archive/archive-store.ts`

**Out of scope** (do NOT touch, even though they look related):
- `extensions/session-archive/archive-store.test.ts` — the failing test must
  pass unmodified. Only touch it if you are *adding* a new test case.
- `extensions/session-archive/archive-ops.ts` — its in-process mutation queue
  is a separate serialization layer; it is correct as is.
- `SCHEMA_SQL` contents — do **not** switch to `CREATE TABLE IF NOT EXISTS`.
  That would mask genuine version drift instead of fixing the race.

## Git workflow

- Branch: `kstack/fix-archive-schema-race` (repo convention: `kstack/<slug>`)
- Single commit; message style matches `git log` (imperative summary line),
  e.g. `Fix cross-process schema init race in session-archive`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Re-check the schema version inside the immediate transaction

In `initializeSchema`, move the authoritative version check inside the
`BEGIN IMMEDIATE` transaction. Keep the outside read only as a fast path.
Target shape:

```ts
function initializeSchema(db: DatabaseSync): void {
	const fast = db.prepare("PRAGMA user_version").get() as { user_version: number };
	if (fast.user_version === SCHEMA_VERSION) return;
	db.exec("BEGIN IMMEDIATE");
	try {
		// Re-read under the write lock: another process may have initialized
		// the schema between the fast-path read and lock acquisition.
		const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
		if (row.user_version === SCHEMA_VERSION) {
			db.exec("COMMIT");
			return;
		}
		if (row.user_version !== 0) {
			throw new ArchiveStoreError(
				`unsupported archive schema version ${row.user_version} (expected ${SCHEMA_VERSION})`,
			);
		}
		db.exec(SCHEMA_SQL);
		db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}
```

Note: the unsupported-version `ArchiveStoreError` is now thrown inside the
try block, so it flows through the `ROLLBACK` path — that is correct and
intentional (there is nothing to roll back yet).

**Verify**: `node --test extensions/session-archive/archive-store.test.ts`
→ output ends with `fail 0` (the previously failing concurrent-import test
now passes).

### Step 2: Run the full extension suite

**Verify**: `node --test extensions/session-archive/*.test.ts` → `fail 0`.
Also confirm no other extension regressed:
`node --test extensions/handoff/*.test.ts` → `fail 0` (handoff imports
`archive-store.ts` read-only helpers).

## Test plan

- The existing test at `archive-store.test.ts:349` is the regression test;
  it must pass without modification.
- Optional (only if trivial): add a same-process test that calls
  `openArchiveDb` twice on the same path sequentially and asserts no throw —
  model its structure on the neighboring tests in the same file.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `node --test extensions/session-archive/*.test.ts` exits 0 with `fail 0`
- [ ] `node --test extensions/handoff/*.test.ts` exits 0 with `fail 0`
- [ ] `git diff --name-only` shows only `extensions/session-archive/archive-store.ts`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `initializeSchema` in the live code no longer matches the excerpt above.
- The concurrent-import test still fails after Step 1 with a *different*
  error than `table archive_sessions already exists` — the race may have a
  second component (e.g. WAL/pragma ordering) that needs human review.
- You find yourself wanting to add `IF NOT EXISTS` to `SCHEMA_SQL` or to
  retry in a loop — both are explicitly out of scope.

## Maintenance notes

- Any future `SCHEMA_VERSION` bump must add a migration path inside the same
  `BEGIN IMMEDIATE` transaction and keep the in-transaction version re-check.
- Reviewer should scrutinize: that `COMMIT` is reached exactly once on every
  path through the try block, and that the unsupported-version error still
  surfaces (there is a test for that in the same file).

# Plan 010: Cache parsed handoff history between tool calls

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat d0a9409..HEAD -- extensions/handoff/history-reader.ts extensions/handoff/history-reader.test.ts`

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW — cache keyed by file identity + size + mtime; staleness
  falls back to a re-read, and correctness never depends on the cache.
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `d0a9409`, 2026-08-14

## Why this matters

Every `read_handoff_history` / `search_handoff_history` tool call re-reads
and re-parses the **entire** previous-session JSONL — up to the module's own
64 MB limit — synchronously on the extension-host event loop
(`readActiveSession` → `readFileSync` + `parseSessionJsonlBytes`). A model
paging through a long prior session issues many of these calls in a row; each
one repeats identical work and blocks the TUI while doing it. The linked
previous session is *inactive by construction* (handoff replaced it), so its
file rarely changes — a validity-checked cache eliminates nearly all repeat
work with ~30 lines.

## Current state

- `extensions/handoff/history-reader.ts`:
  - `MAX_ACTIVE_SESSION_BYTES = 64 * 1024 * 1024` (line ~15).
  - `assertSafeActiveSessionPath` (line ~100) — lstat/realpath/containment
    checks, returns the canonical path. Keep running this on **every** call
    (it is the security boundary; only the parse is cacheable).
  - `readActiveSession` (line ~124): validates, then
    `parseSessionJsonlBytes(readFileSync(canonical))`, then header-id check.
  - Both `readHandoffHistory` and `searchHandoffHistory` call
    `readActiveSession` per invocation.
- The module is pure-functional today (no module state); tests in
  `history-reader.test.ts` build temp session files and call the readers
  directly. An injectable cache keeps that property testable.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Focused tests | `node --test extensions/handoff/history-reader.test.ts` | `fail 0` |
| Extension tests | `node --test extensions/handoff/*.test.ts` | `fail 0` |
| Typecheck (if plan 003 landed) | `npm run typecheck` | exit 0 |

## Scope

**In scope**:
- `extensions/handoff/history-reader.ts`
- `extensions/handoff/history-reader.test.ts` (add cases)

**Out of scope**:
- The archived-DB path (already cheap: indexed SQLite reads, per-call
  read-only connections)
- Path-safety checks (`assertSafeActiveSessionPath`) — must keep running
  per call, uncached
- `handoff-context.ts`, `index.ts`, `model-selection.ts`

## Git workflow

- Branch: `kstack/handoff-history-cache`
- Single commit. Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add a validity-keyed parse cache

Module-level, single-entry cache (one previous session per handoff chain):

```ts
interface ParsedCacheEntry {
	canonical: string;
	size: number;
	mtimeMs: number;
	ino: number;
	sessionId: string;
	parsed: ActiveSession;
}
let parseCache: ParsedCacheEntry | undefined;
/** Test hook. */
export function clearHandoffParseCache(): void { parseCache = undefined; }
```

In `readActiveSession`, after `assertSafeActiveSessionPath` returns the
canonical path: `statSync(canonical)`; if the cache matches
`canonical + size + mtimeMs + ino + source.sessionId`, return
`parseCache.parsed`. Otherwise read/parse as today, verify the header id
(existing check), then populate the cache. On any mismatch or error, fall
through to a fresh read; never serve the cache when the stat differs.

Note the existing behavior to preserve: ENOENT → `undefined` (archive
fallback); header-id mismatch → throw. A cached entry must never bypass the
header-id semantics (caching after the check preserves this).

**Verify**: `node --test extensions/handoff/history-reader.test.ts` → `fail 0`
(existing tests unchanged).

### Step 2: Add cache tests

In `history-reader.test.ts` (call `clearHandoffParseCache()` in setup):
1. Two consecutive reads parse once — assert via a counting wrapper: write
   the file, read, then overwrite the file with **same size and mtime
   forced** is fiddly; instead assert the observable: mutate the file
   *content and size*, and confirm the next read reflects the new content
   (cache invalidated); then stat-match case: two reads without touching the
   file return identical output and (using `process.hrtime` or a spy on a
   small injected `readFileImpl` if you add one) the second performs no file
   read. Prefer adding an optional `fsImpl` parameter for observability over
   timing assertions — follow the `Fs`-injection pattern in
   `extensions/panel-review/review-scope.ts:141`.
2. Append a line to the session file → next read returns the appended entry.
3. Replace the file with a different session id (same path) → next read
   throws the id-mismatch error (cache did not mask it).

**Verify**: `node --test extensions/handoff/history-reader.test.ts` → `fail 0`,
≥3 new tests.

## Test plan

As Step 2. Existing tests must pass unmodified except setup calls to
`clearHandoffParseCache()`.

## Done criteria

- [ ] `node --test extensions/handoff/*.test.ts` exits 0, `fail 0`, ≥3 new tests
- [ ] `grep -n "clearHandoffParseCache" extensions/handoff/history-reader.ts` → exported
- [ ] Safety checks still run per call (`assertSafeActiveSessionPath` call
      count in the code path unchanged — verify by reading the diff)
- [ ] If plan 003 landed: `npm run typecheck` exits 0
- [ ] `plans/README.md` status row updated

## STOP conditions

- Injecting an `fsImpl` for testability forces signature changes in
  `index.ts`'s tool handlers — keep the parameter optional with a default;
  if that is impossible, report.
- Any existing test needs its assertions changed.

## Maintenance notes

- If handoff ever supports *chained* sources (multiple previous sessions),
  the single-entry cache becomes an LRU of small N — note in the module
  docstring.
- Reviewer: confirm the cache key includes `ino` (file replaced via rename
  keeps path+size coincidences honest) and that `sessionId` participates so a
  re-linked handoff never serves the old session's entries.

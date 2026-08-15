# session-archive

A user-level Pi extension that moves completed sessions out of Pi's active
session directories into a read-only, full-text-searchable archive. Archived
sessions disappear from `/resume` and `pi -r`, survive byte-for-byte on disk,
and stay searchable by agents through two SELECT-only tools.

## Requirements

- Node 22 or newer (`node:sqlite`). The extension fails at startup with an
  actionable message when it is unavailable.
- Pi 0.84.1+ (tested against `@earendil-works/pi-coding-agent` 0.84.1).
- Session format v3. Open an older session once in Pi to let Pi upgrade it before archiving.
- A local filesystem for `$PI_CODING_AGENT_DIR`. SQLite WAL and the archive's
  rename/fsync guarantees are not designed for a shared network filesystem or
  a concurrently synchronized database directory.

## Layout

The extension lives at `~/.pi/agent/extensions/session-archive/` and is
auto-discovered by Pi (no build step; jiti loads the TypeScript directly).

All archive state lives under the Pi agent directory — `$PI_CODING_AGENT_DIR`
when set, otherwise `~/.pi/agent`:

```text
<agent-dir>/archive/
├── archive.sqlite3                    # index (WAL, owner-only 0600)
└── sessions/YYYY/MM/<session-uuid>/
    └── session.jsonl                  # byte-for-byte original, mode 0444
```

Both the SQLite index and the JSONL copies are personal mutable data and must
never be committed to a repository. The JSONL file is the byte-identical source artifact; SQLite stores normalized
metadata, extracted search text, FTS data, and byte offsets back into that
artifact. It does **not** duplicate raw JSON lines. `read_session_archive` uses
the stored byte offsets to read raw entries directly from `session.jsonl`.
SHA-256 joins the two and detects drift. The index is reconstructible from the
JSONL artifacts, although an automated reindex command is future work.

## Commands

| Command | Effect |
|---|---|
| `/session-archive` | Confirm, then archive the current session and continue in a new empty session. Named sessions keep their name; unnamed sessions stay unnamed. |
| `/session-archive-other` | Select any number of inactive sessions, confirm once, and archive the selection as one batch. In TUI mode, use arrows to navigate, Space to toggle, Enter to accept, and Escape to cancel. If nothing is checked, Enter accepts the focused session. RPC mode uses repeated selection with an explicit completion choice. Named sessions use their compact name; unnamed sessions use a bounded first-message summary. |
| `/session-archive-all` | Confirm once, then archive every inactive session in this directory as one batch, including unnamed sessions. Malformed, empty, or otherwise unarchivable files are skipped and reported; one failure never aborts the batch. |
| `/session-archives [filter]` | Read-only stats and archived-session listing; optional text filter. |

Archiving is always explicit and confirmed. Nothing is archived automatically
on shutdown, reload, or session switch. Current and inactive sessions may be
archived without names; their archive rows remain unnamed. A selected batch is
processed in picker order. One malformed, stale, or failed session does not
roll back the sessions archived successfully before or after it.

## Agent tools

- `search_session_archive` — FTS5 search over finalized archived sessions
  (`words`, `"quoted phrases"`, `AND/OR/NOT`, `prefix*`) with optional `cwd`,
  `role`, `session_id`, and a bounded `limit`. Returns highlighted snippets
  with session/entry ids.
- `read_session_archive` — page one session's entries by exact session id,
  `normalized` (metadata + extracted text) or `raw` (exact JSONL lines),
  with bounded integer `offset`/`limit`. Raw pages are read from the immutable
  JSONL artifact using SQLite's byte-offset references rather than duplicated
  database content. Large pages are split into bounded `chunk`s; follow the
  returned continuation until the page is complete, then advance to the next
  entry offset.

There is deliberately **no** agent-callable archive/restore/delete/SQL tool.
Mutation is a confirmed user command; agents can only search and read through
SQLite connections opened with `readOnly` and `query_only` enabled.

## Threat model

"Read-only" protects against normal tool use and accidents, not against a
determined agent with shell access:

- Archived JSONL files are mode `0444`; the database is `0600`; directories
  are `0700` (POSIX only).
- The built-in `write` and `edit` tools are blocked (via `tool_call`) from
  targeting anything inside the archive root, including existing files and
  new paths reached through symlinked parent directories.
- No registered tool mutates the archive.

A same-user agent with unrestricted `bash` can still run `chmod`, edit the
SQLite file, or delete archived JSONL. Shell commands are not parsed or
policed. Treat these as accident guards, not a security boundary.

## Known concurrency gap

The extension can identify only the session active in the current Pi process.
It cannot determine whether another Pi process has the same JSONL open. Before
using `/session-archive-other` or `/session-archive-all`, ensure the selected
sessions are not open in any other Pi process. The same caution applies if multiple Pi processes were
explicitly started on one session file.

SQLite transactions serialize catalog writes, but they do not solve this file
liveness problem. Cross-process active-session leases require Pi-level support
or a separate locking design and are intentionally deferred.

## Crash recovery

Archiving is a two-phase state machine (`pending` → `archived`) because the
filesystem and SQLite cannot commit atomically:

1. The session is indexed transactionally as `pending` (all-or-nothing).
2. Only then is the file moved — for the *current* session, strictly after Pi
   has switched to a replacement session, so a live `SessionManager` file is
   never moved. The source is rechecked against its staged size and SHA-256
   immediately before any move or deletion. Same-filesystem moves use atomic
   `rename` and verify the destination; cross-device moves copy to a temp file,
   fsync, verify both the copy and unchanged source, rename into place, and
   only then unlink the source.
3. The file is set `0444` and the row finalized in one transaction.

Every step preserves at least one complete JSONL copy. On the next Pi start,
bounded reconciliation checks only interrupted `pending` operations before
archive tools serve requests:

- destination present + hash matches → chmod, finalize (source removed only
  when it is not the live session file);
- destination absent + source present → left active for an explicit retry;
- both missing, or any hash mismatch → marked `error`, nothing deleted.

Finalized archive files are not hashed during routine startup. The explicit
`/session-archives` command checks finalized rows and reports missing or drifted
files.

Re-running any operation is idempotent: identical bytes at the destination
complete the operation, different bytes are a hard collision error and are
never overwritten. Conflicting pending imports for one session id are also
rejected, and finalization must match the exact staged path and hash.
Cross-process archive-operation safety comes from `BEGIN IMMEDIATE`,
`busy_timeout=5000`, and SQLite uniqueness constraints; this does not imply
cross-process session-liveness detection described above.

## Deferred work

- Add explicit rebuild/reindex, full verification, export, retention/deletion,
  and "continue from archive" maintenance flows. A continuation must create a
  new active session rather than reopen an archived JSONL.

## Development

```bash
# Unit + integration tests (Node 22+; no Pi runtime imports needed)
node --test ~/.pi/agent/extensions/session-archive/*.test.ts
```

Structure:

- `index.ts` — Pi registration and command/session lifecycle only
- `session-choices.ts` — compact named/unnamed picker labels and duplicate disambiguation
- `session-selection.ts` — deterministic multi-selection and RPC fallback state
- `session-picker.ts` — bounded TUI multi-select adapter
- `archive-ops.ts` — testable archive orchestration (no Pi imports)
- `archive-store.ts` — SQLite schema, transactions, queries, byte references
- `session-jsonl.ts` — strict v3 parsing, text extraction, hashes, byte offsets
- `archive-files.ts` — path validation, rename/copy fallback, chmod, guard
- `reconcile.ts` — startup pending-operation recovery and explicit integrity checks
- `tool-output.ts` — UTF-8-safe bounded output chunking
- `*.test.ts` — Node test files beside the modules they cover

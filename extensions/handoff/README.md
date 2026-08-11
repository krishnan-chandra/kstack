# handoff

Continue work in a fresh, lean Pi session while keeping a durable reference to the previous session's history.

`/handoff` does **not** copy the old conversation into the new context and does not call an LLM to summarize it. It builds a small editable prompt containing the user's goal and the previous session reference, then opens a linked replacement session. The next agent follows that reference and reads only the history it needs.

The sessions are linked twice:

- `parentSession` in the new session header preserves Pi's native provenance.
- A visible `handoff` `custom_message` stores the old session's exact file path, session ID, and cwd.

## Usage

```text
/handoff now implement this for teams as well
/handoff execute phase one of the plan
/handoff                          # continue from the prior resume point
```

The editor opens with a deterministic prompt like:

```markdown
Continue work from the previous Pi session.

## Goal
Implement teams support.

## Instructions
1. Inspect the previous session before making changes; inherit its decisions and do not redo completed work.
2. If the active JSONL path exists, read it incrementally and focus on relevant entries.
3. If archived, use read_session_archive with the exact session ID, or search_session_archive with session_id for targeted search.
4. Determine what is done, pending, and the concrete resume point, then continue.

## Previous session
Previous session: /path/to/old-session.jsonl
Session ID: <uuid>  CWD: /path/to/project
Lookup: use the active path above; if it is later archived, use read_session_archive with the exact session ID (or search_session_archive with session_id to search within it)
```

Edit or cancel this prompt before any session replacement occurs. After the switch, submit it when ready.

## Behavior notes

- **Reference-only:** no conversation serialization, synthesis call, generated summary, or inherited conversation payload.
- **On-demand history:** the replacement agent reads the active JSONL with `read`, or uses the [`session-archive`](../session-archive/) tools after archival.
- **No model required:** `/handoff` works even when no model is currently selected because the command itself makes no model call.
- **Persisted sessions only:** ephemeral `--no-session` sessions are rejected because they have no durable history artifact for the next agent to inspect.
- **Interactive only:** the command requires TUI mode so the user can edit the continuation prompt.
- **Cancellable:** cancelling the editor or a `session_before_switch` handler leaves the old session active.

## Tests

```bash
node --test extensions/handoff/*.test.ts
```

The tests verify the deterministic prompt, durable reference, reference-only lifecycle, cancellation paths, and stale-context safety without making any model calls.

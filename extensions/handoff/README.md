# handoff

Transfer the current Pi session to a fresh, focused session without lossy compaction.

`/handoff` reads the canonical (compaction-aware) conversation context, asks an LLM
to synthesize a self-contained continuation prompt, lets you edit it, and opens a
new session with that prompt ready in the editor. The new session is linked to the
old one twice:

- `parentSession` in the session header preserves Pi's native provenance.
- A `handoff` `custom_message` entry stores the old session's file, exact session
  ID, and cwd — the durable identity you can use with `read_session_archive` if
  the old JSONL is later archived (or with `search_session_archive` plus its
  `session_id` filter to search within it), e.g. by the
  [`session-archive`](../session-archive/) extension).

## Usage

```
/handoff now implement this for teams as well
/handoff execute phase one of the plan
/handoff                          # infer the resume point and next step
```

With no argument, the goal defaults to "Continue implementation from the current
resume point." The generated prompt follows this shape:

```
## Context
…decisions, done vs pending, resume point…
Files involved: …

## Task
…

## Previous session
Previous session: /path/to/old-session.jsonl
Session ID: <uuid>  CWD: /path/to/project
Lookup: use the active path above; if it is later archived, use read_session_archive with the exact session ID (or search_session_archive with session_id to search within it)
```

Every step is cancellable: aborting the loader, cancelling the editor, or a
`session_before_switch` handler cancelling the new session leaves the old session
untouched.

## Behavior notes

- **Compaction-aware**: context comes from
  `ctx.sessionManager.buildSessionContext()`, so compacted branches hand off
  their summary plus retained tail.
- **Ephemeral sessions**: with no session file, `parentSession` is omitted and
  the history reference notes the history lives in the prompt only.
- **Context budget**: if the complete synthesis request exceeds ~90% of the
  selected model's context window, handoff stops and recommends `/compact`
  rather than silently dropping recent context. Synthesis output is explicitly
  capped to the remaining context space (and at most 4096 tokens).
- **Interactive only**: requires TUI mode.

## Tests

```bash
node --test extensions/handoff/*.test.ts
```

The lifecycle tests drive `createHandoffHandler` with fake contexts — no Pi
runtime or real LLM calls.

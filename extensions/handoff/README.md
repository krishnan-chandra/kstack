# handoff

Continue work in a fresh, lean Pi session while keeping a durable reference to the previous session's history.

`/handoff` does **not** copy the old conversation into the new context and does not call an LLM to summarize it. It builds a small editable prompt containing the user's goal and the previous session reference, then opens a linked replacement session. The next agent uses read-only handoff tools to retrieve only the history it needs.

The sessions are linked twice:

- `parentSession` in the new session header preserves Pi's native provenance.
- A visible `handoff` `custom_message` stores the old session's exact file path, session ID, and cwd.

## Usage

```text
/handoff now implement this for teams as well
/handoff execute phase one of the plan
/handoff --model anthropic/claude-sonnet-4-5 execute phase one of the plan
/handoff -m openai/gpt-5.2 fix the flaky test
/handoff                          # continue from the prior resume point
```

`--model` (also `-m` or `--model=provider/model-id`) selects the model for the
replacement session. It accepts a canonical `provider/model-id`, a unique bare
model id, or a unique partial id/name match (provider-scoped when the reference
contains a slash). When model scoping is active (`--models` / `enabledModels`),
only scoped models are accepted. Without the flag, the replacement session
starts on the parent session's active model.

The editor opens with a deterministic prompt like:

```markdown
Continue work from the previous Pi session.

## Goal
Implement teams support.

## Instructions
1. Call read_handoff_history before making changes; it reads recent normalized entries and automatically handles active or archived storage.
2. Use search_handoff_history for targeted lookup of a decision, file, error, or topic.
3. Determine what is done, pending, and the concrete resume point, then continue.

## Previous session
Previous session: /path/to/old-session.jsonl
Session ID: <uuid>  CWD: /path/to/project
Lookup: use the active path above; if it is later archived, use read_session_archive with the exact session ID (or search_session_archive with session_id to search within it)
```

Edit or cancel this prompt before any session replacement occurs. After the switch, submit it when ready.

## Read-only history tools

- **`read_handoff_history`** pages through normalized entries from the linked previous session. It defaults to the latest 50 entries and supports `offset`, `limit`, `chunk`, and `from=start|tail`.
- **`search_handoff_history`** searches only the linked previous session, with optional role and result limits.

Both tools derive the source from structured metadata on the `handoff` custom message; they accept no filesystem path or session ID from the model. They validate the active file and exact header ID, omit thinking/image/tool-argument payloads, bound output to 50 KB, and transparently fall back to the archive database opened read-only with `query_only`.

## Behavior notes

- **Reference-only:** no conversation serialization, synthesis call, generated summary, or inherited conversation payload.
- **On-demand history:** the replacement agent retrieves normalized recent entries or targeted matches through the handoff-specific tools.
- **Model selection:** `--model` switches to the requested model right before the replacement session is created; without it, the parent session's active model is pinned so the new session starts on it. Both paths use `pi.setModel()` before `ctx.newSession()`, because a brand-new session resolves its model from the configured default. An unknown or ambiguous model reference fails before the editor opens; a requested model without an API key cancels the handoff. Choosing a model also persists it as the configured default, the same as `/model` or `Ctrl+P`.
- **Model selection limits:** this mechanism works in the default configuration. A startup `pi --model` flag or active model scoping (`--models` / `enabledModels`) takes precedence over it; when that happens the handoff warns about the model the replacement session actually started on instead of claiming the requested one. With scoping active, `--model` only accepts scoped models. Inheritance is best effort: if the parent model cannot be pinned (e.g. its credentials were removed), the handoff proceeds on the configured default and says so.
- **No model required:** `/handoff` works even when no model is currently selected because the command itself makes no model call.
- **Persisted sessions only:** ephemeral `--no-session` sessions are rejected because they have no durable history artifact for the next agent to inspect.
- **Interactive only:** the command requires TUI mode so the user can edit the continuation prompt.
- **Cancellable:** cancelling the editor or a `session_before_switch` handler leaves the old session active. If an explicit `--model` switch was already applied, it is rolled back on the parent session when the replacement is cancelled or fails.

## Tests

```bash
node --test extensions/handoff/*.test.ts
```

The tests verify the deterministic prompt, structured provenance, active and archived reading, normalized output, targeted search, path containment, reference-only lifecycle, cancellation paths, stale-context safety, model flag parsing, model resolution, inheritance, explicit model switching, model restoration on cancelled or failed handoffs, scoped-model validation, and override detection without making any model calls.

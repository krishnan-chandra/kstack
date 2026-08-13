# handoff

Continue work in a fresh, lean Pi session while keeping a durable reference to the previous session's history.

`/handoff` does **not** copy the old conversation into the new context and does not call an LLM to summarize it. It builds a small editable prompt containing the user's goal and the previous session reference. Saving that editor is the only confirmation: the linked replacement session starts immediately with the saved prompt. The next agent uses read-only handoff tools to retrieve only the history it needs.

The sessions are linked twice:

- `parentSession` in the new session header preserves Pi's native provenance.
- A visible `handoff` `custom_message` stores the old session's exact file path, session ID, and cwd.

## Usage

```text
/handoff now implement this for teams as well
/handoff execute phase one of the plan
/handoff --model anthropic/claude-sonnet-4-5 execute phase one of the plan
/handoff --model openai/gpt-5.2:high continue the work
/handoff -m anthropic/claude-opus-4-6:max finish the refactor
/handoff                          # continue from the prior resume point
```

`--model` (also `-m` or `--model=provider/model-id[:effort]`) selects the model
and optional effort for the replacement session. It accepts a canonical
`provider/model-id`, a unique bare model id, or a unique partial id/name match
(provider-scoped when the reference contains a slash). Append `:<effort>` to
request a Pi thinking level: `off`, `minimal`, `low`, `medium`, `high`,
`xhigh`, or `max`. The full model reference is tried first so IDs that already
contain a colon (OpenRouter `:exacto`, Ollama tags) still resolve; only then is
the final colon treated as an effort suffix. When model scoping is active
(`--models` / `enabledModels`), only scoped models are accepted. Without a
suffix, the parent session's effective effort is inherited. Without the flag,
the replacement session starts on the parent session's active model and effort.

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

Edit or cancel this prompt before any session replacement occurs. Saving it starts the replacement session and sends the prompt. Cancelling leaves the old session active.

## Read-only history tools

- **`read_handoff_history`** pages through normalized entries from the linked previous session. It defaults to the latest 50 entries and supports `offset`, `limit`, `chunk`, and `from=start|tail`.
- **`search_handoff_history`** searches only the linked previous session, with optional role and result limits.

Both tools derive the source from structured metadata on the `handoff` custom message; they accept no filesystem path or session ID from the model. They validate the active file and exact header ID, omit thinking/image/tool-argument payloads, bound output to 50 KB, and transparently fall back to the archive database opened read-only with `query_only`.

## Behavior notes

- **Reference-only:** no conversation serialization, synthesis call, generated summary, or inherited conversation payload.
- **Immediate naming:** the replacement session receives a short lowercase slug derived from the handoff goal during setup, before the confirmed prompt is sent.
- **On-demand history:** the replacement agent retrieves normalized recent entries or targeted matches through the handoff-specific tools.
- **Model and effort selection:** `--model` switches to the requested model right before the replacement session is created; an optional `:<effort>` suffix then sets that thinking level. Without a suffix, the parent session's effective effort is pinned. Without `--model`, both the parent model and its effort are pinned so the new session starts on them. Model is applied first so Pi clamps effort against the selected model's capabilities. Both paths use `pi.setModel()` and `pi.setThinkingLevel()` before `ctx.newSession()`, because a brand-new session resolves model and thinking from the configured defaults. An unknown or ambiguous model reference fails before the editor opens; a requested model without an API key cancels the handoff. If the requested effort is unsupported, the handoff warns and continues with the clamped effective level. Choosing a model or effort also persists it as the configured default, the same as `/model` or Shift+Tab. Pinning an already-current effort may briefly bounce through another supported level so Pi writes the default a fresh session can inherit; that can append a bounded thinking-level change to the outgoing session.
- **Model and effort selection limits:** this mechanism works in the default configuration. A startup `pi --model` flag, `--thinking`, or active model scoping (`--models` / `enabledModels`) takes precedence over it; when that happens the handoff warns about the model and effort the replacement session actually started on instead of claiming the requested ones. With scoping active, `--model` only accepts scoped models. Inheritance is best effort: if the parent model cannot be pinned (e.g. its credentials were removed), the handoff proceeds on the configured default and says so.
- **No model required to open the handoff:** `/handoff` itself still makes no model call. Before auto-start, the extension checks that the replacement session has a model and credentials. If that preflight fails, the confirmed prompt stays in the editor.
- **Persisted sessions only:** ephemeral `--no-session` sessions are rejected because they have no durable history artifact for the next agent to inspect.
- **Interactive only:** the command requires TUI mode so the user can edit the continuation prompt.
- **One confirmation:** saving the editor both confirms the prompt and starts the replacement session. There is no second submit after the switch. If preflight finds no model or credentials, the confirmed prompt is left in the editor instead. Errors after message submission begins are surfaced without restoring the prompt because the message might already be recorded; this avoids creating a duplicate turn if the user retries.
- **Cancellable:** cancelling the editor or a `session_before_switch` handler leaves the old session active. If an explicit `--model` or effort switch was already applied, both the parent model and effort are rolled back (model first, then effort) when replacement is cancelled or fails before the new session starts. If there was no previous model, the parent keeps the newly selected model and its effective effort. Once the replacement-session callback begins, the old session API is stale and is not used for recovery.

## Tests

```bash
node --test extensions/handoff/*.test.ts
```

The tests verify the deterministic prompt, replacement-session naming, structured provenance, active and archived reading, normalized output, targeted search, path containment, reference-only lifecycle, one-confirmation auto-start, preflight recovery, post-submission error handling, cancellation paths, stale-context safety, model flag parsing, model and effort resolution (including colon-bearing model IDs), inheritance, explicit model/effort switching and clamping, restoration of model and effort on cancelled or pre-replacement failures, scoped-model validation, and override detection without making any model calls.

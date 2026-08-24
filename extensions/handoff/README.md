# handoff

Continue work in a fresh, lean Pi session while keeping a durable reference to the previous session's history.

`/handoff` does **not** copy the old conversation into the new context and does not call an LLM to summarize it. It builds a small editable prompt containing the user's goal and the previous session reference. Saving that editor is the only confirmation: the linked replacement session starts immediately with the saved prompt. The next agent uses read-only handoff tools to retrieve only the history it needs.

By default, the sessions are linked twice:

- `parentSession` in the new session header preserves Pi's native provenance.
- A visible `handoff` `custom_message` stores the old session's exact file path, session ID, and cwd.

With `--archive`, the active parent path is moved, so the replacement omits the stale `parentSession` path and uses the structured handoff message plus exact archived session ID as its durable provenance.

## Usage

```text
/handoff now implement this for teams as well
/handoff --archive continue in a new session and archive this one
/handoff execute phase one of the plan
/handoff --model anthropic/claude-sonnet-4-5 execute phase one of the plan
/handoff --model openai/gpt-5.2:high continue the work
/handoff -m anthropic/claude-opus-4-6:max finish the refactor
/handoff                          # continue from the prior resume point
```

`--archive` opts into archiving the current session before the confirmed handoff prompt is sent. The flag itself is explicit archive intent, so no separate archive confirmation appears. After the handoff prompt is saved, the old session becomes read-only and leaves `/resume`; the replacement session records that its predecessor is archived and reads it through the exact-ID archive fallback. If archiving fails, the continuation prompt is not sent.

Pi provides argument completion for the finite handoff flags: `--archive`,
`--model`, `--model=`, and `-m`. Model references and the continuation goal stay
free-form, so the completion list does not guess their values.

`--model` (also `-m` or `--model=provider/model-id[:effort]`) selects the model
and optional effort for the replacement session. It accepts a canonical
`provider/model-id`, a unique bare model id, an exact short name, or a unique
partial id/name match (provider-scoped when the reference contains a slash).
Short names come from two centralized sources (see
`extensions/shared/model-aliases.ts`): any `{ "label", "model", "thinking" }`
entry in `kstack.json` (panel-review reviewers, arena runners, pr-autopilot
models, ...) and model display names from the Pi catalogue. Display names
match exactly, case-insensitively, in either their written or slug form
(`Claude Sonnet 4.5` or `claude-sonnet-4.5`); quote names that contain
spaces, e.g. `--model "Claude Sonnet 4.5"`. A kstack.json label's configured
`thinking` level applies when no explicit suffix is given. Append `:<effort>`
to request a Pi thinking level: `off`, `minimal`, `low`, `medium`, `high`,
`xhigh`, or `max`; an explicit suffix always overrides a label's configured
level. The full model reference is tried first so IDs that already
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

- **Reference-only:** no conversation serialization, synthesis call, generated summary, inherited conversation payload, or hidden thinking content. Handoff preserves the selected thinking **level**, not prior reasoning traces.
- **Optional archive-first handoff:** `--archive` runs the session archive state machine before sending the continuation prompt. The replacement metadata explicitly marks the predecessor archived. Archive cancellation leaves the old session active; archive finalization failure leaves the replacement active without auto-submitting the prompt and reports the pending archive recovery instructions.
- **Immediate naming:** the replacement session receives a short lowercase slug derived from the handoff goal during setup, before the confirmed prompt is sent.
- **On-demand history:** the replacement agent retrieves normalized recent entries or targeted matches through the handoff-specific tools.
- **Model and effort selection:** `--model` selects the requested model and optional `:<effort>` for the replacement session. Without a suffix, the parent session's effective effort is inherited; without `--model`, both the parent model and effort are inherited. A brand-new session starts on the configured defaults and `ctx.newSession()` takes no model options, so the switch happens inside the replacement session right after it starts: Pi re-runs extension factories for every replacement runtime, and the handoff factory rebinding hands the still-executing handler the replacement session's live API. Selecting through that API appends the model and effort to the replacement transcript only — the predecessor receives no speculative model or thinking changes and the persisted defaults are untouched. Model is applied before effort so Pi clamps effort against the selected model's capabilities. An unknown or ambiguous model reference fails before the editor opens; handoff reports the effective result before sending the continuation prompt.
- **Model and effort selection limits:** with model scoping active (`--models` / `enabledModels`), `--model` only accepts scoped models. If the selection cannot be applied — for example the model's credentials were removed, or the requested effort is unsupported and clamps — handoff warns with the requested and effective selections (plus the failure reason when Pi reports one) and continues on the replacement's actual state.
- **No model required to open the handoff:** `/handoff` itself still makes no model call. Before auto-start, the extension checks that the replacement session has a model and credentials. If that preflight fails, the confirmed prompt stays in the editor.
- **Persisted, live source only:** ephemeral `--no-session` sessions are rejected, and the recorded session file must still exist immediately before the editor opens. A missing source cannot be advertised as durable handoff history.
- **Interactive only:** the command requires TUI mode so the user can edit the continuation prompt.
- **One confirmation:** saving the editor both confirms the prompt and starts the replacement session. Even with `--archive`, there is no additional archive dialog or second submit after the switch. If preflight finds no model or credentials, the confirmed prompt is left in the editor instead. Errors after message submission begins are surfaced without restoring the prompt because the message might already be recorded; this avoids creating a duplicate turn if the user retries.
- **Cancellable:** cancelling the editor or a `session_before_switch` handler leaves the old session active. Model and effort are applied only inside the replacement session after it starts, so cancellation or replacement failure never requires restoring the predecessor. Once the replacement-session callback begins, the old session API is stale and is not used.

## Tests

```bash
node --test extensions/handoff/*.test.ts
```

The tests verify the deterministic prompt, replacement-session naming, structured provenance, active and archived reading, normalized output, targeted search, path containment, reference-only lifecycle, one-confirmation auto-start, preflight recovery, post-submission error handling, cancellation paths, stale-context safety, model flag parsing, model and effort resolution (including colon-bearing model IDs), selection through the replacement session's live API, inheritance, effort clamping, predecessor immutability, scoped-model validation, and effective-selection mismatch reporting without making any model calls.

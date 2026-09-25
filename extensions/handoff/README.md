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
1. Call read_handoff_history first, with no arguments. Its default outline maps the whole previous session with entry numbers.
2. Expand only the entries you need with read_handoff_history({ view: "entries", offset, limit }).
3. Use search_handoff_history to find a decision, file, command, or error.
4. Inherit prior decisions and do not redo completed work. Determine what is done, what is pending, and the concrete resume point, then continue with the goal above.

## Previous session
Previous session: /path/to/old-session.jsonl
Session ID: <uuid>  CWD: /path/to/project
Lookup: read_handoff_history and search_handoff_history find this session in active or archived storage automatically. Read its history only through those tools; do not open the session file directly.
```

Edit or cancel this prompt before any session replacement occurs. Saving it starts the replacement session and sends the prompt. Cancelling leaves the old session active.

## Read-only history tools

- **`read_handoff_history`** returns an **outline** of the whole linked session by default. Pass `view: "entries"` to page through entries.
- **`search_handoff_history`** returns short snippets with entry numbers for words or quoted phrases, with optional `role` and `limit`.

Both tools derive the source from structured metadata on the `handoff` custom message. They accept no filesystem path or session ID from the model, and they bound output to 50 KB.

### Outline

The outline is a deterministic map computed from the session file on each call; it is not a model-written summary. Its header lists the session, the outlined entry range, `Edit/write targets` with succeeded, failed, and no-result counts, tool-error entry numbers, and the count of calls without a result. Edit and write targets come from `edit` and `write` tool calls, correlated with their results by tool-call ID; shell-driven changes are not tracked.

The body is a sequence of units, each labelled with its entry range (`#12` or `#12–40`):

- `USER:` and `ASSISTANT:` messages, clipped to 300 and 160 bytes. Assistant text within the last 40 entries gets 600 bytes. The final user message (2,000 bytes) and final assistant message (3,000 bytes) keep their line breaks.
- Tool activity aggregated by tool name, such as `→ read ×3 (a.ts, b.ts, +1) · bash (npm test)`. A tool call shows only its name and one allowlisted string argument (`path`, `file_path`, `command`, `pattern`, `query`, `url`, `tool`, `agent`, `name`, or `session_id`).
- `✗ <tool>: <first line>` for each failed tool result, clipped to 160 bytes.
- `COMPACTION:`, `SUMMARY:`, `CUSTOM <type>:`, and `BASH:` units, and a leading `META:` unit for metadata before the first message.

Successful tool output, thinking, images, and `edit`/`write` payloads never appear in the outline. Each unit is capped at 4 KB, the header at 4 KB, and the response at 40 KB. When older units do not fit, the outline starts with `Entries #0–N are not outlined; call read_handoff_history({ before: N+1 })`; following these continuations covers every entry exactly once.

### Entries view

`view: "entries"` keeps the `offset`, `limit` (default 50), `chunk`, and `from=start|tail` paging. Each entry shows its normalized text, and assistant entries list their tool calls as `→ <name> <target>`. Tool results and user shell output are clipped to 800 bytes with an expansion hint. `full: true` returns the complete normalized text; the session parser already caps normalized text at 200,000 characters, and entries at that cap end with a marker saying so.

### Search

Search matches case-insensitive substrings; every word or quoted phrase must appear in the entry text or in a tool-call `name target` summary, so a path that appears only in a tool argument is found. It shows the newest `limit` matches (default 20) in session order. Each match shows its entry number, the matching tool calls, and up to three snippets. A snippet keeps the matched text whole and fills its 260-byte budget with context on both sides, so multibyte context cannot push the match out; a match longer than the budget keeps its start. Each match is capped at 1 KB.

### Storage

The tools read the active JSONL when it still exists at the recorded path. Otherwise they read the finalized archive artifact located by the exact session ID. The archive database is opened read-only, the artifact must be a regular non-symlink `.jsonl` file inside the archive root whose size matches the archive catalog, and its header must carry the referenced session ID. Active and archived sessions therefore share the same outline, entries view, and search semantics.

Archived search previously used SQLite FTS5 token matching ordered by rank. It now uses the same substring matching and newest-first selection as active search, so `hand` matches `handoff` in both.

Archived artifacts over 64 MiB are not parsed. The default call returns `Outline unavailable: …` followed by the entries view from the archive database, without tool-call lines. Search uses the FTS5 index with token matching and rank order, labelled as such, and each hit carries an entry number for the entries view. The header of an oversized artifact is still checked with a bounded first-line read.

## Behavior notes

- **Reference-only:** no conversation serialization, synthesis call, generated summary, inherited conversation payload, or hidden thinking content. Handoff preserves the selected thinking **level**, not prior reasoning traces.
- **Optional archive-first handoff:** `--archive` runs the session archive state machine before sending the continuation prompt. The replacement metadata explicitly marks the predecessor archived. Archive cancellation leaves the old session active; archive finalization failure leaves the replacement active without auto-submitting the prompt and reports pending-archive recovery instructions. If the archive finalizes successfully but replacement continuation fails (such as prompt submission errors), the archive remains completed; the replacement reports the continuation failure and advises inspecting the conversation rather than re-archiving.
- **Immediate naming:** the replacement session receives a short lowercase slug derived from the handoff goal during setup, before the confirmed prompt is sent.
- **On-demand history:** the replacement agent reads the outline first, then expands only the entries or search matches it needs through the handoff-specific tools.
- **Tool allowlists:** Pi applies `--tools` to the whole process, and extensions cannot activate a tool outside it. A replacement session therefore starts with the tools this session allows. `/handoff` predicts them from the current session (handoff tools count when registered; built-ins such as `grep` count only when active) and writes instructions for only those tools:
  - `read_handoff_history` present: the outline-first steps, with search steps only when `search_handoff_history` is also allowed.
  - Only `search_handoff_history`: search-only steps.
  - No handoff reader but `read` or `bash`: steps that search the transcript JSONL with `grep` or `bash` when allowed, then read only the matching line ranges. The path is the active file, or with `--archive` the file's archived location.
  - None of these, as with `--tools ls` or `--no-tools`: `/handoff` stops before opening the editor, so nothing is archived or replaced.

  Degraded modes show a warning before the editor opens.
- **Model and effort selection:** `--model` selects the requested model and optional `:<effort>` for the replacement session. Without a suffix, the handoff inherits the parent session's effective effort. Without `--model`, it inherits both the parent model and effort. A new session starts on the configured defaults, and `ctx.newSession()` takes no model options. The handoff factory therefore publishes each runtime's live selection API through a process-wide, session-keyed `Symbol.for` rendezvous. The predecessor's handler reads that rendezvous inside `withSession`, after Pi has loaded the replacement factory, then applies the model and effort to the replacement. This works even when Pi loads the two runtimes through separate module graphs. The calls append model and effort entries only to the replacement transcript. They do not change the predecessor or persisted defaults. The handler applies the model first so Pi can clamp effort against its capabilities. An unknown or ambiguous model reference fails before the editor opens. Handoff reports the effective selection before it sends the continuation prompt.
- **Model and effort selection limits:** with model scoping active (`--models` / `enabledModels`), `--model` only accepts scoped models. If the selection cannot be applied — for example the model's credentials were removed, or the requested effort is unsupported and clamps — handoff warns with the requested and effective selections (plus the failure reason when Pi reports one) and continues on the replacement's actual state.
- **No model required to open the handoff:** `/handoff` itself still makes no model call. Before auto-start, the extension checks that the replacement session has a model and credentials. If that preflight fails, the confirmed prompt stays in the editor.
- **Persisted, readable default source:** default handoff rejects ephemeral `--no-session` sessions. After Pi becomes idle, it validates the source before opening the editor and again immediately before replacement. A source must be a regular, non-symlink `.jsonl` file under `$PI_CODING_AGENT_DIR/sessions` (default `~/.pi/agent/sessions`), contain valid Pi session JSONL with the current session ID, and be no larger than 64 MiB. Custom session paths and retained child-agent paths are not supported. A missing active file is rejected even if an older archive row has the same ID.
- **Changed source during editing:** if the second default-source check fails, handoff leaves the edited prompt in the current session's editor and makes no replacement or model change. The history tools still validate again when they read the source because a successful preflight cannot prevent later filesystem changes.
- **Archive-first validation:** `--archive` delegates source validation and finalization to the session archive state machine instead of applying the default active-reader preflight. The archive path keeps its existing active-session containment, JSONL, and session-ID checks, but it does not apply the active reader's 64 MiB limit. Use `--archive` when a valid active session exceeds that limit.
- **Interactive only:** the command requires TUI mode so the user can edit the continuation prompt.
- **One confirmation:** saving the editor both confirms the prompt and starts the replacement session. Even with `--archive`, there is no additional archive dialog or second submit after the switch. If preflight finds no model or credentials, the confirmed prompt is left in the editor instead. Errors after message submission begins are surfaced without restoring the prompt because the message might already be recorded; this avoids creating a duplicate turn if the user retries, and the notification advises inspecting the replacement conversation before submitting again.
- **Cancellable:** cancelling the editor or a `session_before_switch` handler leaves the old session active. Model and effort are applied only inside the replacement session after it starts, so cancellation or replacement failure never requires restoring the predecessor. Once the replacement-session callback begins, the old session API is stale and is not used.

## Tests

```bash
node --test extensions/handoff/*.test.ts
```

The tests verify the deterministic prompt, replacement-session naming, structured provenance, active and archived transcript loading, archive artifact validation, the outline representation contract (contiguous unit ranges, per-unit, header, and response bounds, `before` continuations, and payload absence), entries-view clipping and the parser cap marker, snippet search semantics shared by active and archived sources, the oversized-archive fallback, path containment, reference-only lifecycle, one-confirmation auto-start, preflight recovery, post-submission error handling, cancellation paths, stale-context safety, model flag parsing, model and effort resolution (including colon-bearing model IDs), selection through the replacement session's live API, inheritance, effort clamping, predecessor immutability, scoped-model validation, and effective-selection mismatch reporting. The runtime smoke test loads the predecessor and replacement through separate extension module graphs and reproduces the Sol-to-Terra switch with Pi's real `AgentSessionRuntime`. It suppresses `sendUserMessage`, so it makes no provider request.

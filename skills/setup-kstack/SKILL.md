---
name: setup-kstack
description: Configure K-Stack's VCS backend, models, and thinking levels. Use for /setup-kstack, "set up kstack", "switch K-Stack to git or jj", "configure kstack models", "change panel reviewers", "change planner or implementer model", "configure pr-autopilot models", or when kstack.json contains stale, unavailable, or manually edited settings. Detects the repository, discovers Pi's model catalog, previews a validated user-level kstack.json update, and writes only after approval.
license: MIT
compatibility: Pi CLI with `pi --list-models` and `pi auth check`; write access to $PI_CODING_AGENT_DIR (default ~/.pi/agent); jj 0.44+ when selecting the jj backend.
---

# Set up K-Stack

Configure K-Stack's VCS backend and per-role model assignments in the
user-level `$PI_CODING_AGENT_DIR/kstack.json` file. Default to
`~/.pi/agent/kstack.json`. This skill changes runtime configuration, not
repository defaults. It preserves unknown top-level sections so that future
K-Stack extensions keep their settings.

A configuration is useful only when it can run. Discover Pi's catalog, confirm
credentials for every selected provider, validate the complete proposed JSON,
and show the diff before writing. Do not spend tokens on model test calls unless
the user explicitly asks for one.

## 1. Inspect the current state

1. Resolve the target path from `PI_CODING_AGENT_DIR`. Expand a leading `~/` to
   the home directory. Do not use the repository's `kstack.example.json` as the
   write target.
2. Read the target if it exists. Parse it as JSON. If it is malformed or its
   root is not an object, stop without overwriting it. Show the parse error and
   offer a separately named backup-and-repair operation.
3. Read [`../../kstack.example.json`](../../kstack.example.json) and show a
   compact current-state table. Mark missing sections as **built-in default**.
   Do not silently replace a missing section: K-Stack extensions deliberately
   have fallback behavior.

## 2. Discover usable models

Run:

```bash
pi --list-models
```

Use the `provider` and `model` columns together as the config identifier, for
example `openai/gpt-5.6-sol` or `openrouter/moonshotai/kimi-k3`. A row with `thinking`
set to `yes` can take a thinking level. Omit `thinking` for a model that does
not support it.

The catalog says that Pi knows the identifier; it does not prove that the user
can authenticate to every provider. After the user selects models, check each
unique selection without printing credentials:

```bash
pi auth check --model <provider/model> --json
```

A result with `"status":"ready"` passes. If a provider is not ready, keep the
existing assignment or ask for another catalog model. Do not write an unready
selection. `pi --list-models` does not expose every provider's exact
thinking-level map, so use the listed thinking capability as the available
preflight and explain that Pi may clamp a provider-specific unsupported level.

Provider catalogs can lead Pi's bundled catalog. If the user explicitly requests
an exact provider model ID that is absent from `pi --list-models`, accept it only
when `pi auth check --model <provider/model> --json` reports `ready`. Show a
warning in the preview that local catalog metadata (including thinking support
and context limits) is unavailable. Never invent an absent ID or silently choose
one: this exception requires an exact user-supplied identifier.

## 3. Choose the VCS backend

Read the existing `vcs.backend` value. If it is missing, the runtime default is
`git`. Suggest a backend from the current repository, but let the user choose:

1. Run `git rev-parse --show-toplevel`. If it fails, explain that K-Stack's
   mutation workflows require a Git repository, including for a colocated jj
   workspace.
2. Run `jj workspace root`. A successful result that resolves to the same real
   path as the Git root indicates a colocated jj workspace. Suggest `jj` in that
   case and `git` otherwise.
3. If the user selects `jj`, run `jj --version` and require version 0.44 or
   newer. Do not initialize or migrate a repository.
4. Store exactly `{ "backend": "git" }` or `{ "backend": "jj" }` in the
   top-level `vcs` section.

Explain the exclusivity rule before approval: K-Stack sends every repository
mutation through the selected backend. Git mode refuses a jj-managed workspace,
and jj mode requires a colocated workspace. Stack delivery requires jj. Managed
Git worktrees are unavailable in jj mode. PR-autopilot uses the selected backend
for commits, merges, restores, and pushes; `gh` remains the forge client.

## 4. Choose the roles

Start from the existing user configuration. For a missing section, start from
that section in `kstack.example.json`. Ask whether to keep every assignment or
change selected groups. Show the full proposed assignment before asking for
approval.

Use model IDs without a `:thinking` suffix in JSON. Store the effort separately
as `"thinking"`. Use only `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or
`max`.

| Workflow | Roles to configure | Constraints |
| --- | --- | --- |
| `vcs` | `backend` | Use exactly `"git"` or `"jj"`; jj requires a colocated workspace and jj 0.44 or newer. |
| `plan-implement` | `planner`, `implementer`, `timeoutMinutes` | The planner uses `high`, `xhigh`, or `max`; planner and implementer use different model IDs. |
| `fast-implement` | `implementer`, `timeoutMinutes` | The implementer must be one of the bounded pairs `openai/gpt-5.6-sol:low`, `openrouter/deepseek/deepseek-v4-flash:high`, or `openrouter/moonshotai/kimi-k3:medium`; timeout is 1–60 minutes. This low-assurance single-PR workflow is independent of the plan-implement roles. |
| `panel-review` | 2–5 labeled `reviewers`, `synthesis`, concurrency, timeouts | Reviewer labels are unique 1–16-character letters, digits, `_`, or `-`. `maxConcurrency` is 1–5. `maxRuntimeMinutes` is at least `timeoutMinutes`. |
| `kstack-router` | `classifier`, `timeoutSeconds` | `timeoutSeconds` is 1–600. |
| `investigation` | fast `allowedModels`, `defaultModel` | Every entry is one of K-Stack's curated fast investigation models and has at least `medium` thinking. `defaultModel` appears in the list. |
| `arena` | `runners`, `crossJudge`, `maxConcurrency` | Give runners short, unique labels. Prefer a cross-judge from a different model family than the runners. |
| `swarm` | `worker`, `maxConcurrency` | Use a fast worker for broad coverage work. |
| `pr-autopilot` | 2–5 labeled `models`, concurrency, idle and runtime timeouts | Labels and models are unique; thinking is at most `low`; `maxConcurrency` is 1–5; `maxRuntimeMinutes` is at least `timeoutMinutes`. Prefer cheap, fast models from distinct families. |

Keep the current timeouts and concurrency values unless the user asks to change
them. Keep at least two distinct model families in a panel when available. Warn,
but do not block, if synthesis uses the same model as a reviewer. A different
synthesis model makes agreement and disagreement easier to interpret.

The investigation list has a stricter allowlist than the other roles. Its valid
model IDs are currently:

```text
openai/gpt-5.6-luna
google-vertex/gemini-3.7-flash
openrouter/deepseek/deepseek-v4-flash
openai/gpt-5.6-terra
openrouter/deepseek/deepseek-v4-pro
openrouter/z-ai/glm-5.2
```

When the user requests a different investigator, explain that `how`, `why`,
`recall`, and `decision-trail` enforce this shared allowlist. Keep the existing
list or select from the list above.

## 5. Validate the proposed document

Before showing the preview, check all of these conditions:

- `vcs.backend` is exactly `"git"` or `"jj"`. If it is `"jj"`, jj 0.44 or
  newer is available. Warn when the selected backend does not match the current
  repository shape; the runtime preflight will refuse mutation there.
- Every selected `provider/model` either appears in `pi --list-models` or is an
  exact user-requested provider ID that passed the catalog-lag exception above.
  Every selected provider passed `pi auth check`.
- The proposed root remains a JSON object. Preserve unrelated top-level keys
  byte-for-byte in meaning, including settings for extensions this skill does
  not know.
- Each configured section has the shape and constraints in the table above.
- `panel-review.reviewers` contains 2–5 entries and has a `synthesis` entry.
- `plan-implement.planner` and `implementer` are distinct, and the planner has
  high-or-deeper thinking.
- `fast-implement`, when configured, has one authenticated implementer from its bounded allowlist above and a 1–60 minute timeout.
- The investigation rules above hold.
- `pr-autopilot.models` contains 2–5 unique labels and model IDs, every thinking
  level is `off`, `minimal`, or `low`, concurrency is 1–5, idle timeout is
  1–15 minutes, and max runtime is 2–60 minutes and not below idle timeout.

Use the existing extension validators as the source of truth when they are
available. A validation error is a reason to revise the preview, not to delete
an entire section and start over.

## 6. Preview, then write atomically

Render a unified diff from the current JSON to the complete proposed JSON. State
all warnings, including duplicate reviewer/synthesis models, any model whose
thinking support is not fully discoverable, and exact user-requested IDs accepted
through the catalog-lag exception. Ask for explicit approval of this
exact preview.

After approval only:

1. Create the target directory with mode `0700` if it does not exist.
2. Write formatted JSON (two-space indentation and one trailing newline) to a
   new private temporary file in the target directory.
3. Re-read and parse the temporary file. Do not replace the target if parsing
   fails.
4. Rename the temporary file over `kstack.json`. A rename in the same directory
   keeps readers from seeing a partial document.
5. Read and parse the installed file once more. Report its path and the changed
   role groups.

Do not update `kstack.example.json`, commit anything, or change a project-local
file as part of this workflow. If the user wants to change repository defaults,
show a separate diff after the user-level update succeeds and wait for a second
explicit approval.

## 7. Verify and hand off

Run `pi --list-models` once more only if the user changed authentication while
configuring. Otherwise the successful credential checks and final JSON parse are
the local verification.

Tell the user that new child runs use the configuration immediately. An already
running child process keeps the model it started with. If they changed installed
skills or extensions too, remind them to run `/reload` or restart Pi.

**Reply:** the target path, selected VCS backend, changed role groups, selected
model IDs with thinking levels, validation warnings, and whether the write
occurred.

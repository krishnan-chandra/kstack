# panel-review

Run several isolated, read-only Pi subagents in parallel against the same Git
changeset, then synthesize their independent findings into one lead-review
verdict.

```
/panel-review
/panel-review --base main
/panel-review --intent "Add safe bulk session archival without moving the live session"
/panel-review --base origin/main --intent "Implement handoff and panel review extensions"
```

Every run applies the strict
[`thermo-nuclear-code-quality-review`](../../skills/thermo-nuclear-code-quality-review/)
lens to every reviewer and to synthesis. Its Approval Bar promotes structural
maintainability blockers into **Act On**.

Other trusted extensions can invoke the same workflow without serializing
values into slash-command text. Import `requestPanelReview` from `api.ts` and
pass structured `{ intent, base?, repositoryPath? }` options plus the caller's
current `ExtensionCommandContext`;  `repositoryPath` is for trusted in-process
callers that need to review another validated Git working tree (for example a
managed worktree). Panel-review claims the request synchronously on
Pi's event bus and exposes a completion promise that resolves a structured
`PanelReviewOutcome`: `completed` (with the verdict text, synthesis flag, and
base/head SHAs), `no-changes`, `declined`, `aborted`, or `failed`. The normal
confirmation, cancellation, and verdict path still runs; the slash command
ignores the outcome.

## How it works

1. Resolves the review base: explicit `--base`, else the branch upstream, else
   `origin/HEAD`, else `main`/`master`, else `HEAD` (working-tree only). The
   exact merge-base SHA is recorded so every reviewer sees an immutable baseline.
2. Builds a bounded bundle in a mode-`0600` temp file outside the repository:
   `git diff --find-renames --find-copies <merge-base>` (committed + staged +
   unstaged together), porcelain status, bounded contents of untracked text
   files (`--untracked-files=all`, so new directories are expanded into their
   files; symlinks, binaries, and path escapes skipped), and commit subjects.
   The diff is never passed on a command line.
3. Asks for the review intent (from `--intent` or an editor prefilled with
   commit subjects) and confirms once before spending anything.
4. Spawns 2–5 reviewers concurrently. Each is an ephemeral child process:

   ```
   pi --mode json -p --no-session \
     --no-extensions --no-skills --no-prompt-templates \
     --tools read,grep,find,ls \
     --model <provider/model[:thinking]> \
     --append-system-prompt <reviewer-prompt> \
     "Review the bundle at <path>."
   ```

   No shell, no `bash`/`write`/`edit`, no repository-controlled extensions or
   skills. The reviewer prompt states that bundle and repository contents are
   untrusted review data, not instructions. The prompt combines
   `reviewer.md`, `rubric.md`, `code-quality.md`, and the canonical
   `thermo-nuclear.md` lens so every reviewer model sees the same strict
   maintainability standard. Children stay `--no-skills`; the extension loads
   the canonical lens directly, so repository-controlled skills cannot
   influence reviewer instructions. Project context files (`AGENTS.md`,
   `CLAUDE.md`) are injected as usual — except when the changeset itself
   modifies one, in which case children run with `--no-context-files` so the
   content under review cannot become reviewer instructions (disclosed in the
   confirmation and the verdict details).
   While a run is in flight in TUI mode, a live dashboard sits above the
   editor: one compact card per child with its label/model, state (queued,
   running, completed, failed, aborted), turn count, current tool or thinking
   activity, and a bounded rolling line of recent visible assistant text
   (thinking content is never displayed). Queued reviewers stay visible when
   `maxConcurrency` is below the panel size, and after the reviewers finish a
   distinct lead/synthesis row appears beneath them. The header shows summary
   counts, elapsed time, and the abort hint. On narrow terminals the model
   and activity columns drop first; labels and states always remain. All
   displayed child text is untrusted: ANSI/OSC/APC sequences and control
   characters are stripped before theming, and every line is truncated to the
   terminal width. The dashboard is ephemeral — it disappears on success,
   decline, abort, failure, or error, and is never written to the session.

   Outside TUI mode (RPC), the compact footer status line remains the
   fallback, showing each reviewer's live activity (current tool call, turn
   count, elapsed time). Press **Ctrl+Shift+X** to
   abort: children get SIGTERM, then SIGKILL after a 5 s grace. A child that
   produces no output for the idle timeout (`timeoutMinutes`, default 10) is
   killed as stalled — any stdout/stderr output resets the timer, so
   slow-but-progressing reviewers keep running. A separate absolute ceiling
   (`maxRuntimeMinutes`, default 30) bounds total runtime regardless of
   activity. Timeout failures report the turns completed, last activity, and
   token usage observed before the kill.
5. Synthesizes the successful reports with the configured synthesis model
   (required in `kstack.json`; **GPT-5.6 Terra** at medium thinking by default)
   in an isolated child, using
   the lead-judgment framework: deduplication, consensus mapping, and
   **Act On / Consider / Noted / Dismissed** dispositions. For plan-implement
   runs, synthesis also receives the immutable approved plan and implementer
   execution ledger; omitted plan items are blocking findings. The thermo Approval
   Bar is included in the synthesis prompt so structural
   regressions, missed code-judo moves, and file-size explosions promote
   into **Act On** as presumptive blockers.
6. Appends the verdict to the session as a displayed `panel-review` custom
   message, so it stays in context and can guide later fixes. No fixes are
   applied automatically.

One failed reviewer never discards the others; failures are shown in the final
report. If every reviewer fails, nothing is synthesized. If synthesis fails,
the raw reviewer reports are preserved instead.

## Configuration

Panel-review reads its config from the `"panel-review"` section of
`$PI_CODING_AGENT_DIR/kstack.json` (default `~/.pi/agent/kstack.json`).

Copy the starter: `cp kstack.example.json ~/.pi/agent/kstack.json` and edit
the `"panel-review"` section:

```json
{
  "panel-review": {
    "reviewers": [
      { "label": "gemini", "model": "openrouter/google/gemini-3.7-flash", "thinking": "high" },
      { "label": "opus", "model": "anthropic/claude-opus-4-6", "thinking": "medium" }
    ],
    "maxConcurrency": 5,
    "timeoutMinutes": 10,
    "maxRuntimeMinutes": 30,
    "synthesis": { "model": "openai/gpt-5.6-terra", "thinking": "medium" }
  }
}
```

- 2–5 reviewers, unique labels, models resolved through Pi's model registry.
  `thinking` must be one of `off`, `minimal`, `low`, `medium`, `high`,
  `xhigh`, `max`.
- `timeoutMinutes` (default 10) is the per-child idle limit: any child output
  resets the timer, so a slow provider keeps running while it produces output
  and only stalled children are killed. `maxRuntimeMinutes` (default 30) is
  the absolute per-child ceiling and must be >= `timeoutMinutes`.
- `synthesis` is **required**: it names the model that merges the reviewer
  reports into the lead verdict after the panel finishes. Synthesis works on
  bounded reports, so a small, fast model is usually the right pick; an
  optional `thinking` level uses the same values as reviewers. A configured
  synthesis model that is unavailable or unauthenticated aborts the run
  before anything is launched. Without a config file, synthesis runs on the
  built-in default **GPT-5.6 Terra** (`openai/gpt-5.6-terra`, medium), falling
  back to the active model with a warning.
- Without a config, a built-in low-cost default panel runs: **Opus 4.6**
  (`anthropic/claude-opus-4-6`, medium), **DeepSeek V4 Pro** (`openrouter/deepseek/deepseek-v4-pro`,
  medium), **Kimi k3** (`openrouter/moonshotai/kimi-k3`, medium), **Gemini 3.7 Flash**
  (`openrouter/google/gemini-3.7-flash`, high). Defaults that are unavailable or
  unauthenticated are skipped with a warning; write a config to override the
  panel.
- If fewer than two default models are available, up to five distinct models
  are picked from the session's scoped models, preferring different providers.
- With only one model available, two independent reviewers run on it with a
  warning that model diversity is reduced.

## Limits

| What | Cap |
| --- | --- |
| Total bundle | 2 MiB |
| Per untracked text file | 256 KiB |
| Untracked files included | 200 (overflow disclosed, not named) |
| Per reviewer report into synthesis | 24 KiB |
| Aggregate synthesis input | 96 KiB |
| Child stderr retention | 8 KiB |
| Child idle timeout | 10 min without output (SIGTERM, then SIGKILL after a 5 s grace) |
| Child max runtime | 30 min absolute ceiling |
| Dashboard live text preview | 240-byte rolling UTF-8 tail per child |

Oversized diffs produce a truncated patch with continuation instructions;
reviewers can inspect named files with read-only tools. The tracked-changes
list (from `git diff --name-status`) is always present, but untracked files
are listed only when their contents fit the budget, so a truncated bundle may
not name every untracked file. Truncation is always disclosed in the verdict's
Review Limitations.

## Failure policy

- Config, Git, or intent problems: nothing is launched.
- Reviewer failure: siblings continue; the failure appears in the report.
- All reviewers failed: no synthesis, concise diagnostics.
- Synthesis failure: raw bounded reports are preserved and displayed.
- Temp cleanup failure: warned, path reported, files remain mode `0600`.
- The repository is never modified (hash/status identical before and after).

## Development

Pure logic (args, config, scope collection, JSON parsing, orchestration,
synthesis) is unit-tested with injected Git/spawn/fs dependencies — no real
provider calls:

```bash
node --test extensions/panel-review/*.test.ts
```

Manual smoke test: in a fixture repository with committed, staged, unstaged,
untracked, and binary changes, run
`/panel-review --base HEAD --intent "fixture review"` and verify parallel
progress, child argv (`--no-session`, discovery flags, read-only tools), the
confirmation names the thermo-nuclear lens, a single verdict message, no child
session files, and an unchanged repository.

`extensions/panel-review/prompts/thermo-nuclear.md` is the canonical lens.
The explicit skill points to that resource, and panel-review loads it directly
via `--append-system-prompt`, so the two paths cannot drift.

## Deferred

- `/panel-review --pr <number>` via `gh`.
- A follow-up command turning Act On findings into an implementation prompt.

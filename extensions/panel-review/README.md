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
4. Spawns 2–4 reviewers concurrently. Each is an ephemeral child process:

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
   untrusted review data, not instructions. Project context files (`AGENTS.md`,
   `CLAUDE.md`) are injected as usual — except when the changeset itself
   modifies one, in which case children run with `--no-context-files` so the
   content under review cannot become reviewer instructions (disclosed in the
   confirmation and the verdict details).
   While a run is in flight, the footer shows each reviewer's live activity
   (current tool call, turn count, elapsed time). Press **Ctrl+Shift+X** to
   abort: children get SIGTERM, then SIGKILL after a 5 s grace. Any child also
   stops on its own after a 10-minute wall-clock timeout.
5. Synthesizes the successful reports with the configured synthesis model
   (required in `panel-review.json`; a small, fast model like
   `openrouter/google/gemini-3.5-flash-lite` by convention) in an isolated child, using
   the lead-judgment framework: deduplication, consensus mapping, and
   **Act On / Consider / Noted / Dismissed** dispositions.
6. Appends the verdict to the session as a displayed `panel-review` custom
   message, so it stays in context and can guide later fixes. No fixes are
   applied automatically.

One failed reviewer never discards the others; failures are shown in the final
report. If every reviewer fails, nothing is synthesized. If synthesis fails,
the raw reviewer reports are preserved instead.

## Configuration

Panel-review reads its config from the `"panel-review"` section of
`$PI_CODING_AGENT_DIR/kstack.json` (default `~/.pi/agent/kstack.json`). If
`kstack.json` is absent or has no `"panel-review"` key, the legacy standalone
`panel-review.json` in the same directory is tried as a fallback.

Copy the starter: `cp kstack.example.json ~/.pi/agent/kstack.json` and edit
the `"panel-review"` section:

```json
{
  "panel-review": {
    "reviewers": [
      { "label": "qwen", "model": "openrouter/qwen/qwen3.8-max", "thinking": "high" },
      { "label": "kimi", "model": "openrouter/moonshotai/kimi-k3", "thinking": "high" }
    ],
    "maxConcurrency": 4,
    "synthesis": { "model": "openrouter/google/gemini-3.5-flash-lite" }
  }
}
```

- 2–4 reviewers, unique labels, models resolved through Pi's model registry.
  `thinking` must be one of `off`, `minimal`, `low`, `medium`, `high`,
  `xhigh`, `max`.
- `synthesis` is **required**: it names the model that merges the reviewer
  reports into the lead verdict after the panel finishes. Synthesis works on
  bounded reports, so a small, fast model is usually the right pick; an
  optional `thinking` level uses the same values as reviewers. A configured
  synthesis model that is unavailable or unauthenticated aborts the run
  before anything is launched. Without a config file, synthesis runs on the
  built-in default `openrouter/google/gemini-3.5-flash-lite`, falling back to
  the active model with a warning.
- Without a config, a built-in low-cost default panel runs: **Qwen3.8 Max**
  (`openrouter/qwen/qwen3.8-max`, high), **Kimi K3** (`openrouter/moonshotai/kimi-k3`,
  high), and **GPT-5.6 Sol** (`openai/gpt-5.6-sol`, low). Defaults that are
  unavailable or unauthenticated are skipped with a warning; write a config to
  override the panel.
- If fewer than two default models are available, up to four distinct models
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
| Child wall-clock timeout | 10 min (SIGTERM, then SIGKILL after a 5 s grace) |

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
progress, child argv (`--no-session`, discovery flags, read-only tools), a
single verdict message, no child session files, and an unchanged repository.

## Deferred

- `/panel-review --pr <number>` via `gh`.
- A follow-up command turning Act On findings into an implementation prompt.

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
   files (symlinks, binaries, and path escapes skipped), and commit subjects.
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
   untrusted review data, not instructions.
5. Synthesizes the successful reports with your active model (also in an
   isolated child) using the lead-judgment framework: deduplication, consensus
   mapping, and **Act On / Consider / Noted / Dismissed** dispositions.
6. Appends the verdict to the session as a displayed `panel-review` custom
   message, so it stays in context and can guide later fixes. No fixes are
   applied automatically.

One failed reviewer never discards the others; failures are shown in the final
report. If every reviewer fails, nothing is synthesized. If synthesis fails,
the raw reviewer reports are preserved instead.

## Configuration

`$PI_CODING_AGENT_DIR/panel-review.json` (fallback `~/.pi/agent/panel-review.json`):

```json
{
  "reviewers": [
    { "label": "glm", "model": "openrouter/z-ai/glm-5.2", "thinking": "xhigh" },
    { "label": "kimi", "model": "openrouter/moonshotai/kimi-k3", "thinking": "high" }
  ],
  "maxConcurrency": 4
}
```

- 2–4 reviewers, unique labels, models resolved through Pi's model registry.
  `thinking` must be one of `off`, `minimal`, `low`, `medium`, `high`,
  `xhigh`, `max`.
- Without a config, a built-in low-cost default panel runs: **GLM-5.2**
  (`openrouter/z-ai/glm-5.2`, xhigh), **Kimi K3** (`openrouter/moonshotai/kimi-k3`,
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
| Per reviewer report into synthesis | 24 KiB |
| Aggregate synthesis input | 96 KiB |
| Child stderr retention | 8 KiB |

Oversized diffs produce a complete file manifest plus a truncated patch with
continuation instructions; reviewers can inspect named files with read-only
tools. Truncation is always disclosed in the verdict's Review Limitations.

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
- Interactive abort button in the TUI (runner-level SIGTERM/SIGKILL abort is
  implemented and tested; the command currently runs to completion).
- A follow-up command turning Act On findings into an implementation prompt.

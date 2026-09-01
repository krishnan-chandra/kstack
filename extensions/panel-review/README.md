# panel-review

Run several isolated, non-editing Pi subagents in parallel against the same Git
changeset, jj working-copy commit, or GitHub PR, then synthesize their
independent findings into one lead-review verdict.

```
/panel-review
/panel-review Add safe bulk session archival without moving the live session
/panel-review --base main Implement handoff
/panel-review --base origin/main "Implement handoff and panel review extensions"
/panel-review --pr 42
/panel-review --pr 42 "Review the auth refactor"
```

Typing `/panel-review --` in the TUI offers `--base`, `--base=`, `--pr`, and
`--pr=` as completions; flag values and the free-form review intent are not
completed. `--base` and `--pr` are mutually exclusive.

Every reviewer independently runs the full
[`thermo-nuclear-code-quality-review`](../../skills/thermo-nuclear-code-quality-review/)
across the entire changeset. Reviewers do not split the diff or specialize by
rubric dimension; duplicate coverage is intentional. Synthesis applies the same
Approval Bar and promotes structural maintainability blockers into **Act On**.

Other trusted extensions can invoke the same workflow without serializing
values into slash-command text. Import `requestPanelReview` from `api.ts` and
pass structured `{ intent, base?, pr?, repositoryPath? }` options plus the
caller's current `ExtensionCommandContext`. `PanelWorktreeArgs` and
`PanelPrArgs` expose the two mutually exclusive target shapes. `repositoryPath`
is for trusted in-process callers that need to review another validated Git
working tree, such as a managed worktree. Panel-review claims the request
synchronously on
Pi's event bus and exposes a completion promise that resolves a structured
`PanelReviewOutcome`: `completed` (with the verdict text, synthesis flag, and
base/head SHAs), `no-changes`, `aborted`, or `failed`. The normal
cancellation and verdict path still runs; the slash command
ignores the outcome.

## How it works

1. Resolves the review target:
   - In a colocated jj workspace, snapshots the working copy through jj and
     pins revision `@`. This works in both the primary workspace and secondary
     workspaces created by `jj workspace add`, which do not have their own
     `.git` entry. An explicit `--base` is resolved as a jj revision; otherwise
     the base is `trunk()`. The committed diff covers
     `merge-base(base, @)..@`, including the current jj change and its
     description. Unresolved conflicts stop the run before reviewers launch.
     Ignored files are excluded because jj does not snapshot them.
   - In PR mode (`--pr <number>`), fetches the PR head and base source refs
     from `origin` with an empty refmap, then verifies the pinned commit OIDs
     locally. The fetch writes objects but does not update local or
     remote-tracking refs. The diff covers only the committed range
     `merge-base(baseOid, headOid)..headOid`; it excludes untracked files and
     working-tree changes. `git archive` extracts the pinned
     head into a private temporary directory for reviewer file access. The run
     does not create, move, or reset branches, Git worktrees, or jj workspaces.
     PR trees that contain symbolic links are rejected before extraction so
     reviewer reads cannot escape the snapshot root. The temporary snapshot is
     removed when the run ends.
   - In standard Git mode, resolves the review base: explicit `--base`, else
     the branch upstream, else `origin/HEAD`, else `main`/`master`, else `HEAD`
     (working-tree only). The exact merge-base SHA is recorded so every reviewer
     sees an immutable baseline.
   - jj and PR targets are extracted into private temporary source snapshots.
     Reviewers inspect the pinned commit rather than the live workspace. The run
     does not create, move, or reset Git worktrees, jj workspaces, branches, or
     bookmarks.
2. Builds a bounded bundle in a mode-`0600` temp file outside the repository:
   `git diff --find-renames --find-copies <merge-base>` (committed + staged +
   unstaged together), porcelain status, bounded contents of untracked text
   files (`--untracked-files=all`, so new directories are expanded into their
   files; symlinks, binaries, and path escapes skipped), and commit subjects.
   The diff is never passed on a command line.
3. Obtains the review intent (from positional arguments or an editor prefilled
   with commit subjects) and launches reviewers immediately without confirmation prompts.
4. Spawns 2–5 reviewers concurrently. Each is an isolated child process with a retained native session:

   ```
   pi --mode json -p --session-dir ~/.pi/kstack/subagents \
     --session-id <uuid> --name panel-review/<label> \
     --no-extensions --no-skills --no-prompt-templates \
     --extension <bundled-session-archive/index.ts> \
     --tools bash,read,grep,find,ls,search_session_archive,read_session_archive \
     --model <provider/model[:thinking]> \
     --append-system-prompt <reviewer-prompt> \
     "Run a complete independent thermo-nuclear review of the entire bundle at <path>. Apply every relevant rubric dimension and the full Approval Bar."
   ```

   No `write`/`edit` and no repository-controlled extensions or skills. The
   trusted bundled session-archive extension is loaded explicitly so reviewers
   can search and page finalized archived sessions. Reviewers may use `bash` for
   investigation, tests, typechecks, and builds, but their contract forbids
   commands that mutate source, Git state, dependencies, configuration, or
   session data. This is not an OS sandbox: shell access runs with the user's
   permissions and can technically mutate any accessible data. The reviewer
   prompt states that bundle, repository, and transcript contents are
   untrusted review data, not instructions. The prompt combines
   `reviewer.md`, `rubric.md`, `code-quality.md`, and the canonical
   `thermo-nuclear.md` lens. Every child must complete the whole review against
   the entire changeset instead of handling one panel slice. Children stay
   `--no-skills`; the extension loads the canonical lens directly, so
   repository-controlled skills cannot
   influence reviewer instructions. Project context files (`AGENTS.md`,
   `CLAUDE.md`) are injected as usual — except when the changeset itself
   modifies one, in which case children run with `--no-context-files` so the
   content under review cannot become reviewer instructions (disclosed in the
   verdict details).
   While a run is in flight in TUI mode, a live dashboard sits above the
   editor: one compact card per child with its label/model, state (queued,
   running, completed, failed, aborted), turn count, current tool or thinking
   activity, and a bounded rolling line of recent visible assistant text
   (thinking content is never displayed). Queued reviewers stay visible when
   `maxConcurrency` is below the panel size, and after the reviewers finish a
   distinct lead/synthesis row appears beneath them with the selected lead
   model. The header shows summary
   counts, elapsed time, and shortcuts: **Ctrl+Shift+V** (`^⇧V`) to open the
   full-screen read-only subagent console, and **Ctrl+Shift+X** (`^⇧X`) to
   abort. On
   narrow terminals the model and activity columns drop first; labels and
   states always remain. All displayed child text is untrusted: ANSI/OSC/APC
   sequences and control characters are stripped before theming, and every line
   is truncated to the terminal width. The dashboard is ephemeral — it
   disappears on success, decline, abort, failure, or error, and is never
   written to the session.

   Press **Ctrl+Shift+V** during a running panel review in TUI mode to open
   the interactive subagent console — a full-screen overlay (closed with
   **Esc**) that replaces the chat until dismissed:
   - **Layout**: On terminals ≥ 100 columns the console shows a bordered
     title bar (run elapsed and total cost), a sidebar listing every child
     with status icon, model, turns, and elapsed time, and a transcript pane
     for the selected child. Below 100 columns it falls back to a compact
     tab-bar layout.
   - **Tabs**: Switch between reviewers (and the lead once revealed) using
     `Left`/`Right`/`Tab`/`Shift+Tab`. Scroll position and follow mode are
     remembered per child, so switching back restores where you were.
   - **Scrolling**: Scroll the selected child's transcript using `Up`/`Down`/
     `PageUp`/`PageDown`/`Home`/`End` (`g`/`G`).
   - **Follow Tail**: `f` toggles auto-scrolling to the live tail (default ON;
     scrolling up disables follow, scrolling to bottom or `f` re-enables it).
   - **Esc**: Closes the console and restores the chat.
   - **Strictly read-only**: Input never reaches child processes; abort
     (**Ctrl+Shift+X**) remains functional while the console is open.
   - **Bounded & ephemeral**: Transcripts are capped at 128 KiB / 1,000 entries
     per child with an eviction notice when earlier lines are dropped; nothing
     is persisted to the session or disk.

   Outside TUI mode (RPC), the compact footer status line remains the
   fallback, showing each reviewer's live activity (current tool call, turn
   count, elapsed time). Press **Ctrl+Shift+X** to
   finish the panel stage early: active reviewer children get SIGTERM, then
   SIGKILL after a 5 s grace, and synthesis immediately starts with every
   report completed so far plus aborted statuses for the rest. Once synthesis
   starts, the same shortcut aborts the synthesis child. A child that
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

One failed or manually aborted reviewer never discards the others; failures and
aborts are shown in the final report. Manual abort advances directly from the
panel stage to synthesis, even when no reviewer completed, so the lead still
produces a final assessment from the available statuses and reports. If every
reviewer fails without a manual abort, nothing is synthesized. If synthesis
fails, the raw reviewer reports are preserved instead.

## Configuration

Panel-review reads its config from the `"panel-review"` section of
`$PI_CODING_AGENT_DIR/kstack.json` (default `~/.pi/agent/kstack.json`).

Copy the starter: `cp kstack.example.json ~/.pi/agent/kstack.json` and edit
the `"panel-review"` section:

```json
{
  "panel-review": {
    "reviewers": [
      { "label": "glm", "model": "openrouter/z-ai/glm-5.2", "thinking": "medium" },
      { "label": "sonnet", "model": "anthropic/claude-sonnet-5", "thinking": "medium" }
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
- Without a config, a built-in low-cost default panel runs: **Claude Sonnet 5**
  (`anthropic/claude-sonnet-5`, medium), **DeepSeek V4 Pro** (`openrouter/deepseek/deepseek-v4-pro`,
  medium), **Kimi k3** (`openrouter/moonshotai/kimi-k3`, medium), **GLM 5.2**
  (`openrouter/z-ai/glm-5.2`, medium). Defaults that are unavailable or
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
| Pinned commit snapshot tracked blob content | 512 MiB |
| Pinned commit snapshot tracked entries | 200,000 |
| Pinned commit snapshot tar archive | 512 MiB |
| Pinned commit snapshot symbolic links | 0 (tree rejected before extraction) |
| Per reviewer report into synthesis | 256 KiB |
| Aggregate synthesis input | 1 MiB |
| Child stderr retention | 64 KiB |
| Child idle timeout | 10 min without output (SIGTERM, then SIGKILL after a 5 s grace) |
| Child max runtime | 30 min absolute ceiling |
| Dashboard live text preview | 240-byte rolling UTF-8 tail per child |
| Console transcript cap | 2 MiB / 5,000 entries per child (oldest evicted with notice) |
| Console entry text cap | 256 KiB per entry (UTF-8 safe head/tail truncation) |

PR and jj snapshot materialization stops before archiving when the pinned tree
exceeds the tracked-byte or entry limit. The archive and extracted tree can
briefly use up to about twice the archive limit in the system temp directory.

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
- Temp cleanup failure: warned and the private path is reported. Bundle files
  remain mode `0600`; snapshot files remain contained by their owner-only temp
  directory.
- Standard Git mode leaves the repository unchanged.
- jj mode performs jj's normal automatic working-copy snapshot, then reads the
  pinned commit from the colocated Git object store. It does not move bookmarks,
  create workspaces, or alter the working-copy commit.
- PR mode fetches objects into the local object database. It leaves the current
  working tree, refs, branches, Git worktrees, and jj workspaces unchanged.
- jj and PR snapshots are created for the run and removed after completion,
  abort, or failure.

## Development

Pure logic (args, config, scope collection, JSON parsing, orchestration,
synthesis) is unit-tested with injected Git/spawn/fs dependencies — no real
provider calls:

```bash
node --test extensions/panel-review/
```

Manual smoke test: in a fixture repository with committed, staged, unstaged,
untracked, and binary changes, run
`/panel-review --base HEAD "fixture review"` and verify parallel
progress, child argv (managed session flags, discovery flags, read-only tools),
a single verdict message, no child session files, and an unchanged repository.
For PR mode, also compare refs and
`git worktree list --porcelain` before and after the run. For jj mode, test both
its primary workspace and a secondary `jj workspace add` workspace without a
`.git` entry. Confirm that reviewers read the pinned `@` snapshot rather than
later changes in the live workspace.

`extensions/panel-review/prompts/thermo-nuclear.md` is the canonical lens.
The explicit skill points to that resource, and panel-review loads it directly
via `--append-system-prompt`, so the two paths cannot drift.

## Deferred

- A follow-up command turning Act On findings into an implementation prompt.

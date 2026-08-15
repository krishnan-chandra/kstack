# Land

`/land` merges one GitHub pull request after `pr-autopilot` verifies that its
current head is ready. The command confirms the exact PR, head SHA, base branch,
and merge method before it asks GitHub to merge or enqueue the PR.

## Usage

```text
/land --pr 42 --method squash
/land --pr 42 --readiness watch
/land
```

If you omit `--pr`, Land resolves the one open PR whose head matches the current
Git branch or jj bookmark, according to the shared `vcs.backend` setting. Land
stops when Git is detached, when the current jj change has no unique bookmark,
or when GitHub finds zero or multiple matching PRs. Pass `--pr` to land without
selecting its local head ref.

Land runs the configured backend's preflight before resolving or mutating the
target. Git mode refuses jj-managed workspaces. jj mode requires jj 0.44 or
newer, a configured identity, and a colocated jj/Git workspace. Automatic jj
discovery requires a bookmark at `@`; otherwise Land reports the change ID and
asks you to create a bookmark or pass `--pr`.

`--readiness` defaults to `check`. Use `watch` to let `pr-autopilot` address
confirmed fixes and wait for CI. If autopilot pushes a new head, Land pins that
newly verified SHA before confirmation.

If you omit `--method`, Land asks you to select one of the repository's enabled
merge methods (squash or rebase only — merge commits are never allowed by
kstack policy).

### Per-repository merge method config

Add a `"land"` section to `~/.pi/agent/kstack.json` to set a default method per
repository and skip both the method-selection and confirmation prompts:

```json
{
  "land": {
    "repos": {
      "owner/frontend": "squash",
      "owner/backend": "rebase"
    }
  }
}
```

Precedence: `--method` CLI flag > per-repo config > interactive prompt. When the
method comes from config (not CLI), the confirmation prompt is also skipped.
Only `"squash"` and `"rebase"` are valid; unknown or invalid values are silently
ignored.

## Safety and partial results

Land never passes `--admin`, `--auto`, or `--delete-branch` to `gh`. It does not
force-push or delete a branch or bookmark. Immediately before the merge command,
Land checks that GitHub still reports the confirmed head ref and SHA. The merge
command also passes `--match-head-commit`.

A successful `gh pr merge` command is not proof that the PR merged. Land polls
GitHub until the pinned PR reports `MERGED`. If GitHub accepts the request but
polling fails, times out, or is cancelled, Land reports `partially-landed` and
preserves the accepted mutation in its result.

Press Ctrl+Shift+L to abort an active subprocess or polling wait. Cancellation
cannot undo a merge or remove a request from a merge queue.

## API

The `kstack:land:request` event accepts typed `LandOptions` with a positive PR
number and returns a structured `LandResult`. The request is claimed
synchronously, and callers await its completion.

## Limits

- GitHub query timeout: 15 seconds
- Merge command timeout: 60 seconds
- Poll interval: 10 seconds
- Maximum verification wait: 30 minutes per PR
- Retained diagnostic output: 8 KiB
- Concurrent Land runs per session: 1

Land currently supports one PR at a time. jj stack advancement is not part of
the public command or API.

## Development

```bash
node --test extensions/land/*.test.ts
npm run typecheck
```

The tests use injected command results. They do not mutate GitHub repositories.

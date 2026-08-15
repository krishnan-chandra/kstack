# Land

`/land` merges a GitHub pull request after `pr-autopilot` verifies its current
head. In jj mode, selecting an upper PR in a confirmed local stack lands the
complete prefix from trunk through that PR. Land confirms the stack once, then
revalidates each pull request before it asks GitHub to merge or enqueue it.

## Usage

```text
/land --pr 42 --method squash
/land --pr 42 --readiness watch
/land
/kstack --route land --pr 42 --readiness watch --method squash
```

If you omit `--pr`, Land resolves the one open PR whose head matches the current
Git branch or jj bookmark, according to the shared `vcs.backend` setting. Land
stops when Git is detached, when the current jj change has no unique bookmark,
or when GitHub finds zero or multiple matching PRs. Pass `--pr` to select a PR
without checking out its local head.

In jj mode, Land asks `jj-stacked-prs` whether the selected PR head closes a
local linear stack. A stack with two or more slices lands bottom-up through the
selected PR. An owned kstack navigation comment also prevents single-PR fallback
when local predecessors are missing. A PR that maps to one slice and has no such
metadata keeps the ordinary single-PR path. Once Land identifies a multi-PR
stack, discovery or preflight failures stop the run. Land never falls back to an
individual middle-stack merge. If the `jj-stacked-prs` listener is unavailable,
Land stops before mutation.

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
kstack policy). `/kstack --route land` uses the same rule: omit `--method` to
keep that chooser.

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
synchronously, and callers await its completion. In jj mode, the request uses
the same stack-prefix discovery as `/land`.

Trusted in-process callers such as `/jj-stack land` may pass a capability from
`issueLandConfirmation()` after they have already obtained consent for that
exact PR. Only that minted object skips Land's interactive merge confirmation.
A boolean or reconstructed payload is ignored. Land still revalidates the PR,
pins the exact head, and passes `--match-head-commit`.

## Limits

- GitHub query timeout: 15 seconds
- Merge command timeout: 60 seconds
- Poll interval: 10 seconds
- Maximum verification wait: 30 minutes per PR
- Retained diagnostic output: 8 KiB
- Concurrent Land runs per session: 1

`/land --pr <number>` lands through the selected PR when its head closes a
confirmed local jj stack. Use `/jj-stack land` or `jj_stack_land` when you want
to name the top bookmark, remote, trunk revset, or stack-size limit explicitly.
Both paths call Land once per pull request with a minted confirmation and retain its
head pin, revalidation, and `--match-head-commit` checks.

## Development

```bash
node --test extensions/land/*.test.ts
npm run typecheck
```

The tests use injected command results. They do not mutate GitHub repositories.

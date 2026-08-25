# Land

`/land` merges a GitHub pull request after `pr-autopilot` verifies its current
head. In jj or Graphite mode, selecting a PR in a confirmed local stack lands
the complete prefix from trunk through that PR. Land confirms the stack once,
then revalidates each pull request before it asks GitHub or Graphite to merge it.

## Usage

```text
/land --pr 42 --method squash
/land --pr 42 --readiness watch
/land
/kstack --route land --pr 42 --readiness watch --method squash
```

Tab-completion offers `--pr`, `--method`, and `--readiness`. `--method` and
`--readiness` then complete their finite values. `--pr` never suggests a number.

If you omit `--pr`, Land resolves the one open PR whose head matches the current
Git branch or jj bookmark, according to the shared `vcs.backend` setting. Land
stops when Git is detached, when the current jj change has no unique bookmark,
or when GitHub finds zero or multiple matching PRs. Pass `--pr` to select a PR
without checking out its local head.

In Graphite mode, Land delegates stack landing through the shared
`kstack:stack:land-through-pr` channel claimed by `graphite-stacked-prs`. The
provider derives the bounded prefix from exact GitHub head/base relationships,
verifies every local branch at the exact remote SHA, and requires the selected
branch to be checked out. It also checks local Graphite descendants, so an
unpublished child prevents fallback to the generic single-PR path. A related
bottom, middle, or top branch routes through native `gt merge`; a branch with
no open stack relatives keeps the ordinary exact-head GitHub path. Graphite
stack landing rejects `--method` because repository/Graphite settings own the
merge strategy and queue policy.

In jj mode, Land requests `kstack:stack:land-through-pr` claimed by
`jj-stacked-prs` to determine whether the selected PR head matches a local
bookmark. A matching one-slice or multi-slice prefix uses stack landing: it lands
bottom-up through the selected PR, abandons each landed local range, removes
stale bookmarks, refreshes trunk, deletes verified remote branches, and settles
a safe empty working copy onto refreshed trunk. Discovery or preflight blockers,
including blockers on a single slice, stop the run rather than falling back to
ordinary single-PR landing. An owned kstack navigation comment likewise prevents
fallback when local predecessors are missing. The ordinary exact-head GitHub
path remains only when no local bookmark matches the PR head and metadata does
not identify missing stack predecessors. If the stack provider is unavailable,
Land stops before mutation.

Land runs the configured backend's preflight before resolving or mutating the
target. Git mode refuses jj-managed workspaces. jj mode requires jj 0.44 or
newer, a configured identity, and a colocated jj/Git workspace. Automatic jj
discovery requires a bookmark at `@`; otherwise Land reports the change ID and
asks you to create a bookmark or pass `--pr`.

`--readiness` defaults to `check`. Use `watch` to let `pr-autopilot` address
confirmed fixes and wait for CI. A watch is bounded: each CI watch waits up to
20 minutes, and the readiness run also has a cycle limit. If checks remain
pending, Land stops before merging or advancing the local stack. Inspect the PR,
then retry `/land` after CI settles. Do not rebase or republish unless the PR
head or base changed. If autopilot pushes a new head, Land pins that newly
verified SHA before confirmation.

If you omit `--method`, Land uses the repository's only enabled merge method
without another selection or merge-confirmation prompt. When both squash and
rebase are enabled, Land asks you to choose and then confirm. Merge commits are
never allowed by kstack policy. `/kstack --route land` follows the same rules.

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

Precedence: `--method` CLI flag > per-repo config > the repository's only
enabled method > interactive prompt. When the method comes from config (not
CLI), the confirmation prompt is also skipped. A CLI or configured method that
the repository has disabled is blocked before readiness work or mutation. Only
`"squash"` and `"rebase"` are valid; unknown or invalid values are silently
ignored. This configuration applies only to standalone and jj-frontier GitHub
merges, not native Graphite stack landing.

## Safety and partial results

Land never passes `--admin`, `--auto`, or `--delete-branch` to `gh`. It does not
force-push or delete a branch or bookmark. Immediately before the merge command,
Land checks that GitHub still reports the confirmed head ref and SHA. The merge
command also passes `--match-head-commit`.

A successful `gh pr merge` command is not proof that the PR merged. Land polls
GitHub until the pinned PR reports `MERGED`. If GitHub accepts the request but
polling fails, times out, or is cancelled, Land reports `partially-landed` and
preserves the accepted mutation in its result.

Graphite stack landing parses the exact affected branch list from a native dry
run before confirmation and again after exact topology revalidation under the
shared repository publication lock. The lock is keyed by the canonical common
Git directory, so linked worktrees cannot publish or land concurrently.
It invokes `gt merge` once, then waits for every pinned PR verification to
settle and preserves each successful merge result even if another verifier
fails. A lost or nonzero merge process is treated as indeterminate/partial and
is never retried automatically. After every pinned PR is verified merged, Land
runs `gt sync` under the same publication lock so Graphite can update trunk,
restack descendants, and clean up merged local branches. A sync failure is a
post-merge warning: the verified landing remains successful and Land asks you
to run `gt sync` manually.

Press Ctrl+Shift+L to abort an active subprocess or polling wait. Cancellation
cannot undo a merge or remove a request from a merge queue.

## API

The `kstack:land:request` event accepts typed `LandOptions` with a positive PR
number and returns a structured `LandResult`. The request is claimed
synchronously, and callers await its completion. In jj and Graphite modes, the
request uses the same stack-prefix discovery as `/land`.

Trusted in-process callers such as `/jj-stack land` may pass a capability from
`issueLandConfirmation()` after they have already obtained consent for that
exact PR. A boolean or reconstructed payload is ignored. Land also skips the
interactive merge confirmation for a configured method or a repository's only
enabled method. Every path still revalidates the PR, pins the exact head, and
passes `--match-head-commit`.

Trusted stack callers may pass a separate pr-autopilot confirmation, so each
readiness pass runs without additional prompts. A plain `/land`, and any caller
that provides only a Land confirmation, still confirms mutating autopilot runs
interactively.

## Limits

- GitHub query timeout: 15 seconds
- Merge command timeout: 60 seconds
- Poll interval: 10 seconds
- Maximum verification wait: 30 minutes per PR
- Retained diagnostic output: 8 KiB
- Concurrent Land runs per session: 1

`/land --pr <number>` lands through the selected PR when its head closes a
confirmed local jj or Graphite stack. Use `/jj-stack land` or `jj_stack_land` when you want
to name the top bookmark, remote, trunk revset, or stack-size limit explicitly.
Both paths call Land once per pull request with a minted confirmation and retain its
head pin, revalidation, and `--match-head-commit` checks.

## Development

```bash
node --test extensions/land/
npm run typecheck
```

The tests use injected command results. They do not mutate GitHub repositories.

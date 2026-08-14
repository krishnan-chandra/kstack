# Land

`/land` merges one GitHub pull request after `pr-autopilot` verifies that its current head is ready. The command confirms the exact PR, head SHA, base branch, and merge method before it asks GitHub to merge or enqueue the PR.

## Usage

```text
/land --pr 42 --method squash
/land --pr 42 --readiness watch
/land
```

If you omit `--pr`, Land resolves the one open PR whose head matches the current Git branch. Pass `--pr` to land a PR without checking out its head branch. Land stops if branch-based discovery finds zero or multiple PRs.

`--readiness` defaults to `check`. Use `watch` to let `pr-autopilot` address confirmed fixes and wait for CI. If autopilot pushes a new head, Land pins that newly verified SHA before confirmation.

If you omit `--method`, Land asks you to select one of the repository's enabled merge methods.

## Safety and partial results

Land never passes `--admin`, `--auto`, or `--delete-branch` to `gh`. It does not force-push or delete a branch. Immediately before the merge command, Land checks that GitHub still reports the confirmed head ref and SHA. The merge command also passes `--match-head-commit`.

A successful `gh pr merge` command is not proof that the PR merged. Land polls GitHub until the pinned PR reports `MERGED`. If GitHub accepts the request but polling fails, times out, or is cancelled, Land reports `partially-landed` and preserves the accepted mutation in its result.

Press Ctrl+Shift+L to abort an active subprocess or polling wait. Cancellation cannot undo a merge or remove a request from a merge queue.

## API

The `kstack:land:request` event accepts typed `LandOptions` with a positive PR number and returns a structured `LandResult`. The request is claimed synchronously, and callers await its completion.

## Limits

- GitHub query timeout: 15 seconds
- Merge command timeout: 60 seconds
- Poll interval: 10 seconds
- Maximum verification wait: 30 minutes per PR
- Retained diagnostic output: 8 KiB
- Concurrent Land runs per session: 1

Land currently supports one PR at a time. jj stack advancement is not part of the public command or API.

## Development

```bash
node --test extensions/land/*.test.ts
npm run typecheck
```

The tests use injected command results. They do not mutate GitHub repositories.

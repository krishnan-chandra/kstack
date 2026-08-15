# jj-stacked-prs

Inspect, plan, publish, sync, and advance a **linear** Jujutsu bookmark stack
as GitHub draft pull requests. Local history stays in `jj`. Bookmarks are PR
boundaries. Publication is a confirmed command, not a model-callable mutation.

```text
/jj-stack inspect [--top <bookmark>] [--trunk <revset>] [--max-stack <1..50>]
/jj-stack plan --top <bookmark> --remote <name> [--trunk <revset>] [--max-stack <1..50>]
/jj-stack publish --top <bookmark> --remote <name> [--trunk <revset>] [--max-stack <1..50>]
/jj-stack sync --top <bookmark> --remote <name> [--trunk <revset>]
/jj-stack advance --merged <bookmark> --top <bookmark> --remote <name> [--trunk <revset>]
```

Read-only model tools:

```text
jj_stack_inspect({ top?, trunk?, maxStack? })
jj_stack_plan({ top, remote, trunk?, maxStack? })
```

There is no publish, sync, advance, or generic jj mutation tool. A plan ID
proves freshness, not authorization.

## What it does

- Inspects `trunk()..<top>` with structured `jj` templates.
- Derives one PR slice per bookmark. Unbookmarked changes belong to the next
  bookmark. An empty working-copy child above the top is allowed.
- Plans pushes, draft-PR creation, and base repairs from local/remote bookmark
  targets and open PRs in the same GitHub repository.
- Publishes only after standard `ctx.ui.confirm` and a fresh post-confirmation
  plan-ID match.
- Syncs only the selected stack: `jj git fetch --remote <remote>` then
  `jj rebase -b <top> -o <trunk>`.
- Advances after GitHub reports the `--merged` bookmark's PR as `MERGED` and
  that bookmark is the bottom current slice. It abandons `<trunk>..<merged>`
  before fetch, then rebases any remainder. It does not republish; run
  `/jj-stack publish` separately.

## What it does not do

- Non-linear, merge-commit, multi-base, or parallel stacks.
- Install or authenticate `jj` or `gh`.
- Merge PRs, mark them ready, assign reviewers, delete remote branches, or
  force-push with raw Git.
- One-line wrappers for `jj new`, `jj edit`, `jj split`, or `jj absorb`.
- A custom TUI dashboard or a cross-process publication lock.

See [docs/workflows.md](docs/workflows.md) for manual local jj operations and
[docs/safety-and-recovery.md](docs/safety-and-recovery.md) for recovery.

## plan-implement

`plan-implement --stack` probes this extension before any model call. Structural
publication uses `requestStackPublication`. The publisher child may then edit
titles/bodies for the trusted PR map and recommend reviewers. It does not push,
create PRs, repair bases, or update navigation comments.

## API

- `requestJjStackCapabilities(pi)` — cheap loaded-schema probe.
- `requestStackPublication(pi, input, ctx)` — discovery, planning, confirmation,
  stale checking, and apply. The extension owns confirmation.

Completed outcomes return a base-to-top PR map. Other outcomes are
`declined`, `busy`, `blocked`, `stale`, `partial`, `cancelled`,
`indeterminate`, or `failed`.

## Limits

| Item | Limit |
| --- | --- |
| Stack size | 1–50 changes |
| Subprocess stdout / stderr | 512 KiB / 64 KiB, capped while reading |
| Command timeout | 20s jj, 30s gh |
| Abort grace | 5s SIGTERM then SIGKILL |
| Tool content | 50 KiB / 2,000 lines |
| Navigation comment | 100 entries / 60 KiB |
| Concurrent mutation runs | 1 per session |

Press **Ctrl+Shift+J** to abort an active mutation. Session shutdown aborts the
active controller. Cancellation after a mutator starts is `indeterminate` when
remote acceptance cannot be disproved.

## Security and failure

Extensions run with the user's OS permissions. This is not a sandbox. Commands
operate on `ctx.cwd` only. `repositoryPath` exists for trusted in-process
callers such as `plan-implement`.

Partial and indeterminate results list completed or in-flight actions and
require a fresh plan. The extension never rolls back a valid push, PR creation,
or base repair. Comment failures are reported separately.

Cross-process duplicate publication is deferred. Two Pi processes can still
publish the same stack; use one session.

## Development

```bash
node --test extensions/jj-stacked-prs/*.test.ts
npm run typecheck
npm run check:exports
```

Tests inject process and GitHub/jj adapters. They do not use real credentials
or mutate a real GitHub repository.

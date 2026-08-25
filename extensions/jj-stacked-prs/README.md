# jj-stacked-prs

Inspect, plan, publish, sync, advance, and land a **linear** Jujutsu bookmark
stack as GitHub pull requests. Local history stays in `jj`. Bookmarks are PR
boundaries. Publication and landing are available through confirmed commands.
Model-callable tools treat the user's explicit request as authorization.

```text
/jj-stack inspect [--top <bookmark>] [--trunk <revset>] [--max-stack <1..50>]
/jj-stack plan --top <bookmark> [--remote <name>] [--trunk <revset>] [--max-stack <1..50>]
/jj-stack publish --top <bookmark> [--remote <name>] [--trunk <revset>] [--max-stack <1..50>] [--ready]
/jj-stack sync --top <bookmark> [--remote <name>] [--trunk <revset>]
/jj-stack advance --merged <bookmark> --top <bookmark> [--remote <name>] [--trunk <revset>]
/jj-stack land --top <bookmark> [--remote <name>] [--trunk <revset>] [--method squash|rebase] [--readiness check|watch] [--max-stack <1..50>]
```

Tab-completion covers the action names, each action's flags, and the finite
`--method` / `--readiness` values. Bookmark, remote, trunk, and `--max-stack`
values stay free-form.

Model tools:

```text
jj_stack_inspect({ top?, trunk?, maxStack? })
jj_stack_plan({ top, remote?, trunk?, maxStack? })
jj_stack_publish({ top, remote?, trunk?, maxStack?, ready? })
jj_stack_land({ top, remote?, trunk?, method?, readiness?, maxStack? })
```

`jj_stack_publish` pushes bookmarks, creates draft PRs, repairs PR bases, and
reconciles navigation comments without a UI confirmation. `jj_stack_land` lands
the stack the same way. Pi calls either tool only after the user explicitly
asks. There is no sync, advance, or generic jj mutation tool. A plan ID proves
freshness, not authorization.

## What it does

- Inspects `trunk()..<top>` with structured `jj` templates. Inspect, plan, and
  landing confirmation output report jj change and PR slice counts separately.
- Derives one PR slice per bookmark. Unbookmarked changes belong to the next
  bookmark. An empty working-copy child above the top is allowed.
- Plans pushes, draft-PR creation, and base repairs from local/remote bookmark
  targets and open PRs in the same GitHub repository.
- Generates each new draft's title and body from the slice subject, commit
  descriptions, and changed paths. When the repository defines one default
  pull-request template, publication preserves its headings, comments, and
  checklist items, fills its sections, and validates its recognizable title
  rules before the first remote mutation. Repositories without a template use
  the shared `PrDocument` (`## Summary` plus a thematic `## Review guide`).
  Publication does not call a model, so session thinking level cannot abort the
  stack. Existing PR metadata remains unchanged. Rewrite drafts with the
  `write-pr` skill when you want richer prose.
- Publishes from `/jj-stack publish` after standard `ctx.ui.confirm`, or from
  `jj_stack_publish` after an explicit user request. Both paths recompute the
  plan and refuse a stale plan ID before mutation. Metadata generation for all
  new PRs finishes before the first push. Pass `--ready` to mark the published
  drafts ready after the structural work.
- Syncs only the selected stack: `jj git fetch --remote <remote>` then
  `jj rebase -b <top> -o <trunk>`.
- Advances only when inspection has no blockers, the merged PR's head commit
  matches the local bottom bookmark, and GitHub reports that PR as `MERGED`.
  It abandons `<trunk>..<merged>` before fetch, then rebases any remainder. It
  does not republish; run `/jj-stack publish` separately.
- Lands the stack bottom-up through the `land` extension. One confirmation
  covers the whole plan, including each frontier's autopilot pass — no
  per-PR prompts. Each frontier is marked ready if needed, merged with
  a minted Land confirmation, advanced locally, verified onto trunk, republished,
  and has its remote branch deleted only after those checks. `--readiness`
  defaults to `watch`. In jj mode, `/land --pr <number>` delegates here when the
  selected PR closes a local stack with two or more slices. After the final
  frontier lands, the same empty, bookmark-less working-copy child that began
  directly above the selected stack is rebased onto refreshed trunk. Its change
  ID is preserved, and unrelated working copies are left in place.

## What it does not do

- Non-linear, merge-commit, multi-base, or parallel stacks.
- Install or authenticate `jj` or `gh`.
- Assign reviewers, enable auto-merge, pass `--admin`, or force-push with raw Git.
- One-line wrappers for `jj new`, `jj edit`, `jj split`, or `jj absorb`.
- A custom TUI dashboard or a cross-process publication lock.
- Landing without the `land` and `pr-autopilot` extensions.

See [docs/workflows.md](docs/workflows.md) for manual local jj operations and
[docs/safety-and-recovery.md](docs/safety-and-recovery.md) for recovery.

## plan-implement

`plan-implement --stack` probes this extension before any model call. Structural
publication uses `requestStackPublication`. The publisher child may then edit
titles/bodies for the trusted PR map and recommend reviewers. It does not push,
create PRs, repair bases, or update navigation comments.

## Shared stack channels

In jj mode (`vcs.backend = "jj"`), this extension claims the four shared stack
provider channels defined in [`extensions/shared/stack/`](../shared/stack/README.md):

- `kstack:stack:capabilities` (`provider: "jj"`)
- `kstack:stack:preflight` (`provider: "jj"`)
- `kstack:stack:publish` (`provider: "jj"`)
- `kstack:stack:land-through-pr` (`provider: "jj"`)

These channels allow `plan-implement --stack` and `/land --pr` to interoperate
with Jujutsu stacks without direct extension-to-extension dependencies.

Completed outcomes return a base-to-top PR map using the shared stack
vocabulary in [`extensions/shared/stack/`](../shared/stack/README.md)
(`ref`, `topRef`, `baseRef`). Other outcomes are `declined`, `busy`,
`blocked`, `stale`, `partial`, `cancelled`, `indeterminate`, or `failed`.

## Limits

| Item | Limit |
| --- | --- |
| Stack size | 1–50 changes |
| Subprocess stdout / stderr | 512 KiB / 64 KiB, capped while reading |
| Command timeout | 20s jj, 30s gh |
| Abort grace | 5s SIGTERM then SIGKILL |
| Tool content | 50 KiB / 2,000 lines |
| Metadata input per slice | 128 KiB diff / 32 KiB log |
| Repository PR template | 24 KiB, exactly one default |
| Generated PR body | 30 KiB |
| Navigation comment | 100 entries / 60 KiB |
| Concurrent mutation runs | 1 per session |
| Ready + branch-delete `gh` calls | 30s each |
| Per-frontier merge verification | land's existing 30 min |

Press **Ctrl+Shift+J** to abort an active mutation. Session shutdown aborts the
active controller. Cancellation after a mutator starts is `indeterminate` when
remote acceptance cannot be disproved.

## Security and failure

Extensions run with the user's OS permissions. This is not a sandbox. Commands
operate on `ctx.cwd` only. `repositoryPath` exists for trusted in-process
callers such as `plan-implement`.

Diffs and commit descriptions are untrusted metadata input. Generated metadata
must pass title, size, placeholder, and repository-template checks before GitHub
receives it. Publication stops without remote mutation when template discovery,
evidence collection, metadata generation, or conformance validation fails.

Partial and indeterminate results list completed or in-flight actions and
require a fresh plan. A valid local slice with no pull request reports
`publish-required`; publish the stack before retrying landing. The extension
never rolls back a valid push, PR creation, or base repair. It does not write
navigation comments after a core publication or ready-state mutation fails. If
a navigation-comment write fails after successful publication, later comment
writes are skipped and the error is reported separately.

Publication acquires an advisory per-repository file lock under
`<agentDir>/kstack-locks/`. A second process that attempts to publish the same
repository is blocked with the holder's pid and start time. Locks owned by a
dead pid are reclaimed automatically; an unreadable or corrupt lock receives a
one-hour grace period before reclamation. A live holder is never displaced just
because publication runs for a long time. If a process is killed during the
brief reclamation step, a `.reaper` file can conservatively block later stale
cleanup; remove it only after verifying that no publication is active. The lock
covers publication only; advance, sync, and land are not yet covered.

## Development

```bash
node --test extensions/jj-stacked-prs/
npm run typecheck
npm run check:exports
```

Tests inject process and GitHub/jj adapters. They do not use real credentials
or mutate a real GitHub repository.

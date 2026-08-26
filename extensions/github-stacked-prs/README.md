# github-stacked-prs

GitHub-native stack provider for the plain Git backend. It uses Git branches,
the shared GitHub gateway, and kstack navigation comments. GitHub does not have
a native stacks API, so navigation comments remain the stack-topology store.

The extension claims the four shared stack channels for provider `"github"`:

- `kstack:stack:capabilities`
- `kstack:stack:preflight`
- `kstack:stack:publish`
- `kstack:stack:land-through-pr`

It also registers `/gh-stack publish` and the `gh_stack_publish` tool.

## Publish a stack

`plan-implement --stack` writes a private schema-version-1 manifest. The parent
validates the manifest against the clean Git working tree, immutable trunk and
branch SHAs, branch ancestry, and the checked-out top branch before it changes
the remote.

To republish an existing local stack, derive the same manifest from Git
ancestry:

```text
/gh-stack publish --top kstack/top
/gh-stack publish --top kstack/top --remote origin --ready
```

The command fetches the remote-tracking trunk and walks first-parent history
from the selected top branch to its merge-base with trunk. The merge-base must
be the fetched trunk SHA; otherwise, rebase the local stack before publishing.
Every PR boundary must be a local `kstack/` branch tip in one strict linear
chain. A non-kstack branch tip or a merge commit in that range blocks
publication.

`gh_stack_publish` accepts the same `top`, `remote`, and `ready` values. The
tool mutates the remote without another UI confirmation, so call it only after
an explicit user request to publish the current stack.

Publication acquires the shared repository lock, recomputes its plan, and then
pushes branches bottom-up. Existing branches use
`--force-with-lease=refs/heads/<branch>:<exact-sha>`. The provider creates draft
PRs, repairs bases, optionally marks drafts ready, and reconciles navigation
comments. Comment failures are warnings after core publication succeeds.

## Land a stack prefix

With `vcs.backend: "git"` and the default `vcs.stackProvider: "github"`,
`/land --pr <number>` checks the selected PR's navigation comment. A PR without
stack membership falls through to ordinary single-PR landing. Selecting any PR
in a multi-PR stack, including its bottom PR, uses stack orchestration so the
provider advances and republishes dependent PRs.

Local branches are required. Before confirmation, every unmerged branch must
match its remote PR head, and the branches must form a clean linear chain. For
each frontier, the provider asks Land to merge the exact pinned 40-character
head SHA. It then fetches trunk, rebases the remainder with
`git rebase --update-refs`, revalidates every remote head, and atomically
force-pushes the remainder with exact leases. It repairs PR bases, updates
navigation comments, and deletes the verified merged branch.

Before each advance, recovery handles record the old branch tips as
`ref@sha`. A rebase conflict triggers `git rebase --abort` and returns a
partial result. The merged PR remains merged; use the recovery handles to
inspect or restore local refs before retrying.

## Configuration

Git uses this provider by default:

```json
{
  "vcs": {
    "backend": "git",
    "stackProvider": "github"
  }
}
```

Set `stackProvider` to `"none"` to disable stack membership checks and restore
single-PR-only landing for Git. jj and Graphite always use their matching stack
providers and ignore this key with a warning.

## Refusals and limits

The provider refuses:

- a dirty working tree;
- Git older than 2.38;
- a moved manifest trunk or branch head;
- a non-GitHub remote;
- a non-`kstack/` or ambiguous ancestry-derived stack;
- remote-only stack landing or stale local branches;
- an unbounded or non-linear stack.

Stacks contain at most 50 slices. Refs and subjects are bounded by the shared
manifest parser. Confirmation previews are limited to 16 KiB, and tool output
is limited to 50 KiB. The shared GitHub gateway and subprocess wrappers apply
bounded command timeouts.

Extensions run with the user's full filesystem, Git, and GitHub permissions.
The manifest and navigation comments are untrusted evidence, not a sandbox or
authorization token. The parent validates them again immediately before
mutation. Cancellation cannot undo an accepted push or merge; uncertain remote
acceptance returns an indeterminate or partial outcome.

## Deferred work

The provider intentionally has no `inspect`, `plan`, `sync`, or `advance`
command. Publication confirmation is the plan preview, and advance remains an
internal landing step. A second stack-topology adapter remains deferred until
GitHub provides a real native stacks API.

## Development

```bash
node --test 'extensions/github-stacked-prs/*.test.ts'
npm run typecheck
npm run check:exports
npm run check:imports
```

Tests inject Git and GitHub effects. They do not mutate a real repository or
remote.

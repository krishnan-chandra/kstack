# Sources and divergence

This extension replaces the former `jj-stacked-prs` skill and its Python
publisher. The workflow opinions below are unchanged. Shared GitHub process
access now lives in `extensions/shared/github.ts`, while the live navigation
comment protocol and topology store live in `extensions/shared/stack/topology.ts`.

## Input sources

- **Oliver Nguyen, "Working with Stacked PRs using jj"**
  (`https://olivernguyen.io/w/jj.git/`) — the article that inspired this
  workflow. It documents the jj mental model (working copy is a commit, stable
  change IDs, auto-rebase on edit, conflicts don't block, `jj absorb`,
  colocated mode) and a personal alias setup.
- **Sandy Maguire, "Jujutsu Strategies"**
  (`https://reasonablypolymorphic.com/blog/jj-strategy/`, May 2024) — the
  "changes vs commits" framing and deferred bookmark placement. Commands below
  are normalized to `jj 0.44`.
- **Jujutsu docs** (`https://docs.jj-vcs.dev/latest/`) — revsets, templates,
  and CLI reference. Verified against `jj 0.44.0`.
- **jj-stack** (`https://github.com/keanemind/jj-stack`, `jst`) — the
  publishing tool that inspired the original Python publisher. This extension
  ports those operations to TypeScript using Node, `jj`, Git, and `gh`.

## Tested command versions

Verified against `jj 0.44.0` and `gh 2.97.0`:

- `jj rebase --onto` / `-o`; `-b <bookmark>` rebases a whole branch.
- `jj new -A <rev>` / `jj new -B <rev>`.
- `jj absorb` with `-f`/`--from` and `-t`/`--into`.
- `jj bookmark` subcommands: `create`, `move`, `delete`, `forget`, `list`, `set`.
- `jj split --interactive`.
- `jj resolve -r <rev>`.
- `jj op log`, `jj op show`, `jj op restore`, `jj undo`.
- `jj log --reversed` for base → top ordering.
- `trunk()` resolves to the remote `main`/`master`/`trunk` branch.
- Templates use full `change_id` / `commit_id` internally. Rendering shortens
  them. Native domain objects never store the short form as identity.

## Where this workflow deliberately diverges

- **No blanket `--ignore-immutable`.** Use it only on a specific inspected
  revision with explicit approval.
- **No auto-abandon of CI conflict commits.** Inspect the diff and ancestry
  first.
- **No personal aliases in canonical commands.**
- **No hardcoded `main@origin`.** Use `trunk()` and `jj rebase -b <top> -o`.
- **No `git` mutation.** History mutation goes through `jj`.
- **One bookmark = one PR, but not one commit = one PR.**
- **No `dev`-branch base.** Every stack is rooted at `trunk()`.

## Non-goals

- Merge-commit, multi-base, or parallel stacks.
- Running CI, merging PRs, or deleting remote branches.
- Installing `gh` or performing GitHub authentication.
- A cross-process publication lock. Duplicate-publication races across Pi
  processes are deferred.

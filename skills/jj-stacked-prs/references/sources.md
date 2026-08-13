# Sources and divergence

## Input sources

- **Oliver Nguyen, "Working with Stacked PRs using jj"** (`https://olivernguyen.io/w/jj.git/`) — the article that inspired this workflow. It documents the jj mental model (working copy is a commit, stable change IDs, auto-rebase on edit, conflicts don't block, `jj absorb`, colocated mode) and a personal alias setup. The article is written around the author's Connectly workflow and custom zsh/jj aliases.
- **Sandy Maguire, "Jujutsu Strategies"** (`https://reasonablypolymorphic.com/blog/jj-strategy/`, May 2024) — the "changes vs commits" time-travel framing and deferred bookmark placement (do the work, decide PR boundaries after the fact). The article predates the `branch`→`bookmark` rename and targets `jj`'s older CLI; commands below are normalized to `jj 0.44`.
- **Jujutsu docs** (`https://docs.jj-vcs.dev/latest/`, and `https://jj-vcs.github.io/jj/latest/`) — revsets, templates, and CLI reference. Commands in this skill were verified against `jj 0.44.0`.
- **jj-stack** (`https://github.com/keanemind/jj-stack`, `jst`) — the publishing tool that inspired the bundled implementation. It analyzes local bookmarks, builds the stack graph, pushes bookmarks, creates PRs with correct bases, and maintains navigation comments. The bundled `publish_stack.py` replicates these operations using Python's standard library and the `jj`/`gh` executables, removing the external npm dependency.

## Tested command versions

Verified locally against `jj 0.44.0` and `gh 2.97.0`:

- `jj rebase --onto` / `-o` (alias `-d`/`--destination`); `-b <branch>` rebases a whole branch.
- `jj new -A <rev>` (`--insert-after`), `jj new -B <rev>` (`--insert-before`).
- `jj absorb` with `-f`/`--from` and `-t`/`--into`.
- `jj bookmark` subcommands: `create`, `move`, `delete`, `forget`, `list`, `set`.
- `jj split --interactive`.
- `jj resolve -r <rev>`.
- `jj op log`, `jj op show`, `jj op restore`, `jj undo`.
- `jj log --reversed` for base → top ordering.
- `trunk()` revset resolves to the remote `main`/`master`/`trunk` branch.
- jj template keywords used by the inspector: `change_id.short()`, `commit_id.short()`, `description.first_line().escape_json()`, `empty`, `conflict`, `divergent`, `parents`, `local_bookmarks`, `remote_bookmarks`, `.map(|c| ...)`, `json(...)`, and `self.name()` / `self.normal_target().commit_id().short()` in the `jj bookmark list` template context.

## Bundled publisher (`publish_stack.py`)

The publisher lives at `scripts/publish_stack.py` and uses:

- **`stack_model.py`** — shared bounded command execution, structured `jj` parsing, validation, and PR-slice derivation.
- **`github_stack.py`** — GitHub remote parsing, read-only planning, PR/comment models, and mutation execution via `gh api`.
- **`publish_stack.py`** — thin `plan`/`apply` CLI with stale-plan rejection and structured partial results.

All three modules use only Python's standard library plus the `jj` and `gh` executables. No external pip packages, npm packages, or SDK dependencies.

## Where this skill deliberately diverges

- **No blanket `--ignore-immutable`.** The article aliases it into everything for convenience. We use the safety boundary and only override it on a specific inspected revision with explicit approval.
- **No auto-abandon of CI conflict commits.** The article recommends `jdel` on a conflicted commit that resembles CI-generated text. We require inspecting the diff and ancestry first.
- **No personal aliases in canonical commands.** The article's workflow depends on `j`, `jab`, `jsync`, `jjsync`, `jclean`, etc. These skills use full `jj` syntax so behavior does not depend on the user's `config.toml`.
- **No hardcoded `main@origin`.** The article hardcodes `main@origin`. We use the `trunk()` revset and `jj 0.44`'s `--onto`/`-o` rebase syntax.
- **No `git` mutation.** The article freely mixes `git pr`/`git` with jj. We route all history mutation through `jj` to avoid divergent change IDs in colocated repos.
- **One bookmark = one PR, but not one commit = one PR.** Multiple `jj` changes may share a PR boundary (the changes between two bookmarks). We do not force splitting to one commit per PR, unlike `spr`/`fj`.
- **No `dev`-branch base.** Maguire keeps an empty `dev` change as a private base for all PRs and rebases it onto `main` to propagate conflict fixes to every PR at once. We don't follow that workflow; we root every stack at `trunk()` so the inspector and publisher stay coherent. The conflict-fixes-once-propagation benefit does not require a `dev` branch — fixing any lower change propagates to all descendants via jj's auto-rebase (see [safety-and-recovery.md](safety-and-recovery.md)).

## Non-goals

- This skill does not manage merge-commit stacks, multi-base stacks, or parallelized stacks. Only linear stacks are supported.
- It does not run CI, merge PRs, or delete remote branches; it advances the **local** stack after a verified remote merge.
- It does not install `gh`, or perform GitHub authentication.
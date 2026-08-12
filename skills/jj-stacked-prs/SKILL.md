---
name: jj-stacked-prs
description: Manage linear stacks of GitHub pull requests on top of a Jujutsu (jj) working copy — create, edit, absorb fixes, sync with trunk, publish with jj-stack (`jst`), and advance after a merge. Use whenever the user mentions jj + stacked PRs, bookmarks as PR boundaries, restacking, `jst submit`, "publish this stack", "advance the stack", "sync with main", editing a commit in the middle of a stack, `jj absorb`, or recovering after a stacked PR merge. Even when they don't say "stack" explicitly, if they're using jj and talking about multiple PRs or bookmark boundaries, use this skill.
license: MIT
compatibility: A colocated jj + Git workspace with a remote `main`/`master`/`trunk` branch (so the `trunk()` revset resolves). Requires `jj >= 0.44` and python3 for the read-only inspection helper. Publishing requires `jj-stack` (`jst`) and GitHub auth (`gh` or `GITHUB_TOKEN`); the skill reports missing tools and never installs them silently. Read-only by default — every mutation is a separate, explicitly confirmed step.
---

# Stacked PRs with Jujutsu

Turn a chain of local jj changes into a stack of small, dependent GitHub pull requests. The workflow is opinionated and deliberately narrow:

- **Local history stays in `jj`.** Use native `jj` commands for all editing, rebasing, and absorbing.
- **Bookmarks are PR boundaries.** One bookmark = one PR. Multiple `jj` changes may sit between two bookmarks and go into the same PR; we do **not** force one commit per PR. You can place bookmarks as you go, or defer them until the work is done and then carve PR boundaries at the natural seams — see [references/workflows.md](references/workflows.md).
- **Publishing goes through `jst` (jj-stack).** It infers the bookmark stack, pushes bookmarks, creates PRs, repairs bases after restacking, and maintains navigation comments.
- **Only linear stacks.** Merge commits, conflicted bookmarks, divergent changes, unresolved file conflicts, and bookmarked changes with empty descriptions block submission until fixed.
- **Every mutation is previewed and confirmed.** Read-only inspection comes first; publishing is a later, separately confirmed `jst submit --dry-run` step.

Read [references/workflows.md](references/workflows.md) for exact procedures and [references/safety-and-recovery.md](references/safety-and-recovery.md) for recovery. [references/sources.md](references/sources.md) records the input sources and where this skill deliberately diverges from the Oliver Nguyen article.

## Decide the workflow

1. **Detect the workspace.** Run the inspection helper (below). If it reports `jj` missing, too old, no workspace, or `trunk()` unresolvable, stop and tell the user — do not improvise.
2. **Determine trunk, the top bookmark, the remote, and the PR boundaries.** Ask only what you cannot infer; default the top to the inferred topmost bookmark and the remote to the only GitHub remote.
3. **Inspect the selected stack** base → top with the helper.
4. **Report blockers before mutating.** Conflicts, divergence, merges, empty bookmarked changes, and missing/duplicate bookmarks are listed in `blockers`; surface them verbatim and propose fixes, but do not run any mutation until they are resolved and the user confirms.
5. **Pick the workflow** from [references/workflows.md](references/workflows.md):
   - start / reshape a stack
   - edit a change in the middle (descendants auto-rebase)
   - `jj absorb` a cross-stack fix into the right parents
   - synchronize only the selected stack with trunk
   - publish or update the stack through `jst`
   - process review feedback on a middle PR
   - advance the stack after the bottom PR merges
6. **Reinspect after every history-changing operation** before declaring success.
7. **Preview and confirm publishing** with `jst submit --dry-run` first, then the real run.

## Interactive vs. non-interactive callers

The per-mutation preview-and-confirm contract above is for an **interactive**
user driving Pi: you can ask, and the user can answer. When this skill is
consulted by a non-interactive caller (such as the `plan-implement` stack-mode
implementer, which runs headlessly with no UI channel), there is no one to
confirm with. In that case the caller's **pre-approved plan** is the
authorization for the local mutations it names — the implementer does not
halt for per-mutation confirmation, but still reports each mutation and stops
if evidence contradicts the plan. Publishing (`jst submit`) always remains a
later, separately confirmed step outside the non-interactive caller.

## The inspection helper

Resolve this skill's directory and run the read-only, no-credentials helper. It uses `jj` templates (never parsed human log output) and is bounded in stack size, runtime, and output:

```bash
python3 <skill-dir>/scripts/inspect_stack.py [--repo <path>] [--top <bookmark>] [--trunk 'trunk()']
```

It prints one JSON model: `trunk`, `top`, `all_local_bookmarks`, `stack_size`, `truncated`, and a base → top `stack` array where each entry has `change_id`, `commit_id`, `subject`, `bookmarks`, `remote_bookmarks`, `parents`, and the `empty`/`conflict`/`divergent`/`merge` flags plus `is_working_copy`. The `blockers` array lists anything that prevents submission. Use this model — do not re-derive it with ad-hoc `jj log` calls unless the helper fails (then fall back to the equivalent revsets in [references/workflows.md](references/workflows.md)).

## Response format

Always report the stack as a table base → top, then blockers, then the proposed operations with exact commands, then recovery. Use the stable **change ID** (not the commit ID) when referring to a change during review — change IDs survive rebases; commit IDs do not.

```text
Stack: <trunk-ref> → <top-bookmark>

  PR  Bookmark     Change ID     Base        State
   1  <name>       <change-id>   trunk       ready / needs-push / conflict / …
   2  <name>       <change-id>   <bookmark>  …

Blockers:
- <verbatim from inspect_stack.py blockers, or "none">

Proposed operations:
1. <exact command>
2. <exact command>

Recovery:
- jj op log   # inspect the operation that rewrote history
- jj undo     # undo the last history-rewriting operation
```

## Safety opinions (where this skill diverges)

A few practices from the popular article are **not** copied unchanged:

- **No blanket `--ignore-immutable`.** It defeats a useful safety boundary. Use it only on a specific inspected revision after explicit user approval.
- **No automatic abandonment of a "conflicted CI commit."** Inspect the diff and ancestry first; only abandon once you've confirmed the conflict is generated text, not real code.
- **No personal shell aliases in canonical commands.** Use full current `jj` syntax so behavior does not depend on the user's `config.toml`. (`jst` and `gh` are fine — they are standalone tools.)
- **Prefer current `jj 0.44` syntax:** `jj rebase -b <top> -o 'trunk()'` (`--onto`/`-o`), the built-in `trunk()` revset, `jj new -A`/`-B` for insert-after/before. Don't hardcode `main@origin`.
- **No direct `git commit`, `git rebase`, `git reset`, or force-push** in colocated repos. `git`/`gh` remain fine for read-only interoperability. All mutation goes through `jj`.
- **Git hooks don't run on `jj` operations.** If the repo uses pre-commit hooks, run them manually on the changed files after editing; don't assume they fired.

## Tool availability

- `jj >= 0.44` and `gh` are commonly installed. `jst` (jj-stack) often is not. The inspection helper checks `jj`; before publishing, check `command -v jst` and `gh auth status` yourself. If `jst` is missing, tell the user how to install it (`npm install -g jj-stack`) and stop — never install it for them. `jst`'s absence only blocks publishing, not local stack work.

## Bounded effort

Inspect at most the selected stack (`trunk()..top`). Don't fetch the entire repo history. Cap proposed operations to the stack the user named. If the stack exceeds the helper's `--max-stack`, say so and ask the user to narrow `--top`.

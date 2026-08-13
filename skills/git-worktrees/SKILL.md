---
name: git-worktrees
description: Create, inspect, reuse, repair, and safely remove local Git linked worktrees managed under ~/.pi/kstack/worktrees. Use whenever the user asks to work in a worktree, isolate a change from the current checkout, list or clean up worktrees, prune stale worktree records, or mentions plan-implement/kstack with --worktree. This skill is for Git worktrees, not Jujutsu workspaces.
license: MIT
compatibility: Requires Git with `git worktree` support and python3 for the bundled read-only inspection helper. Managed worktrees default to ~/.pi/kstack/worktrees. Mutations require confirmation in interactive use.
---

# Managed Git worktrees

Create isolated Git linked worktrees without changing files or uncommitted work in the caller's checkout. Keep managed worktrees beneath:

```text
~/.pi/kstack/worktrees/<repo-name>-<repo-hash>/<task-slug>
```

The repository hash comes from the canonical common Git directory, so unrelated repositories with the same basename do not collide. Branches use `kstack/<task-slug>`.

This workflow manages **Git worktrees only**. A Jujutsu workspace (`jj workspace`) is a different isolation mechanism and is not interchangeable with a Git linked worktree. Do not combine `--stack` and `--worktree` in kstack workflows.

## Start with inspection

Resolve this skill's directory and run the read-only helper before proposing creation, reuse, cleanup, or repair:

```bash
python3 <skill-dir>/scripts/inspect_worktrees.py
```

Use `--root <path>` only when the user explicitly chose another managed root. The helper emits bounded JSON with `managed_root`, `worktrees`, `orphans`, and `truncated`. Each worktree reports its owning common Git directory, branch, HEAD, dirty/untracked state, lock/prunable state, inferred base, and whether HEAD is reachable from that base.

For one repository, also inspect Git's authoritative records without parsing human-oriented output:

```bash
git -C <repo> worktree list --porcelain -z
```

Never treat a directory scan alone as authority. Validate the owning repository again immediately before mutation because branches, locks, and working-copy state can change.

## Create a managed worktree

1. Run the bundled read-only planner. It resolves the canonical common Git directory, remote default base, repository hash, collision-free branch, and destination without fetching or mutating:

   ```bash
   python3 <skill-dir>/scripts/plan_worktree.py --repo <repo> --task "<task>"
   ```

2. Review the planner's `base_ref`, immutable `base_sha`, `branch`, and `path`. It prefers the symbolic default branch of `origin`, then other remotes; it falls back through remote and local `main`/`master`, then `HEAD`. Report any fallback.
3. Recheck both the branch and destination. If either exists, do not overwrite or reset it; rerun the planner to allocate `-2`, `-3`, and so on, or offer explicit reuse after inspection.
4. Show the exact base, branch, and destination, then ask for confirmation. An approved non-interactive `plan-implement --worktree` plan already authorizes this one creation; it does not authorize cleanup or publication.
5. Create with argument-separated Git invocation, not shell interpolation:

   ```bash
   mkdir -p ~/.pi/kstack/worktrees/<repo-id>
   git -C <repo> worktree add --no-guess-remote -b kstack/<slug> <destination> <base-sha>
   ```

6. Verify `git -C <destination> rev-parse --show-toplevel`, then report the path, branch, base SHA, and cleanup instructions.

Creating a linked worktree changes shared Git metadata and adds a branch ref. The isolation guarantee is narrower and useful: files and uncommitted changes in the original working tree are not modified.

## Reuse or repair

Reuse only after proving the requested branch and managed path belong to the same common Git directory. Show dirty/untracked and lock state first. Never silently adopt a similarly named worktree from another repository.

Use Git's own operations for repair and movement:

```bash
git -C <owner> worktree repair <path>
git -C <owner> worktree move <old-path> <new-path>
git -C <owner> worktree lock --reason <reason> <path>
git -C <owner> worktree unlock <path>
```

Preview the exact command and confirm each mutation.

## Clean up managed worktrees

Cleanup is scoped to `~/.pi/kstack/worktrees`; do not remove unrelated worktrees elsewhere unless the user names one explicitly.

For each candidate:

1. Re-run the helper and authoritative `git worktree list --porcelain -z` from its owner.
2. Block ordinary removal when tracked changes, staged changes, or untracked files exist.
3. Report lock state and whether the branch HEAD is reachable from the inferred base. Reachability is evidence, not permission: a merged branch can still contain useful local files or context.
4. Ask for confirmation with the exact path and branch.
5. Remove through Git:

   ```bash
   git -C <owner> worktree remove <path>
   ```

6. Delete the branch only as a separate, explicit confirmation after verifying it is no longer checked out:

   ```bash
   git -C <owner> branch -d kstack/<slug>
   ```

7. Prune stale administrative records separately and preview first:

   ```bash
   git -C <owner> worktree prune --dry-run --verbose
   git -C <owner> worktree prune --verbose
   ```

Do not use `rm -rf` for a live worktree. Do not use `git worktree remove --force` or `git branch -D` unless the user explicitly approves discarding the exact state you reported.

An **orphan** is a directory under the managed root that no longer resolves to an owning Git repository. Report it separately. Ordinary worktree cleanup must not delete it. If the user asks to delete an orphan, inspect its contents and require explicit filesystem-deletion approval.

## Response format

```text
Managed root: ~/.pi/kstack/worktrees

Worktrees:
  Repository       Branch                  Path                                      State
  <repo-id>        kstack/<slug>           ~/.pi/kstack/worktrees/<repo>/<slug>      clean / dirty / locked / orphan

Proposed operations:
1. <exact command, or "none">

Safety:
- Base: <ref> @ <sha>
- Original checkout files: unchanged
- Removal blockers: <details or none>

Recovery:
- git -C <owner> worktree list --porcelain
- <specific repair/prune command when relevant>
```

Keep worktrees after publication by default. End creation and plan-implement runs by printing the managed path and explaining that cleanup remains explicit.

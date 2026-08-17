---
name: fix-merge-conflicts
description: Resolve merge conflicts, rebase conflicts, or jj conflicts non-interactively, validate build and tests, and finalize conflict resolution. Use whenever a branch has unresolved conflict markers, a merge/rebase stopped mid-way, or the user asks to fix or resolve conflicts.
---

# Fix merge conflicts

## Trigger

Branch has unresolved merge or rebase conflicts (git conflict markers, stopped rebase/merge, or jj conflicted commits) and needs a reliable path to a buildable state.

## Workflow

1. Detect all conflicting files:
   - git: `git status` / `git diff --name-only --diff-filter=U`; also grep for `<<<<<<<` markers.
   - jj: `jj status` shows conflicted commits; conflicts appear inline in files with `<<<<<<<`/`>>>>>>>` markers (jj uses 7+ marker lines with `+++++++` and `%%%%%%%` sections for multi-way diffs).
2. Resolve each conflict with minimal, correctness-first edits.
3. Prefer preserving both sides when safe. Otherwise, choose the variant that compiles and keeps public behavior stable.
4. Regenerate lockfiles with package manager tools instead of hand-editing (`npm install`, `pnpm install`, etc.).
5. Run compile, lint, and relevant tests.
6. Finalize:
   - git: `git add` resolved files; continue a stopped rebase with `git rebase --continue` only when asked.
   - jj: edits to the conflicted commit are absorbed automatically; run `jj status` to confirm conflicts are gone.
7. Summarize key decisions.

## Guardrails

- Keep changes minimal and readable.
- Do not leave conflict markers in any file — verify with a final grep for `<<<<<<<`, `=======`, `>>>>>>>`.
- Avoid broad refactors while resolving conflicts.
- Do not push, tag, or commit during conflict resolution unless explicitly asked.

## Output

- Files resolved
- Notable resolution choices
- Build/test outcome

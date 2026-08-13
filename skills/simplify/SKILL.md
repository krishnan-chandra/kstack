---
name: simplify
description: Simplify scoped code changes with parallel read-only review lenses (code quality, performance, reuse), then apply targeted cleanup fixes. Use when the user says simplify, clean up, tighten, reduce complexity, remove dead code, or polish a diff; after implementing a feature or refactor; or when local changes feel over-engineered, repetitive, or harder to read than necessary.
license: MIT
compatibility: A repository checkout with git. Primarily read-only review subprocesses; the parent may edit scoped files and run lightweight checks. Do not commit, push, or publish unless asked.
---

# Simplify

Reduce complexity in scoped code without changing behavior. Parallel read-only reviewers surface simplification opportunities; the parent applies only targeted fixes that preserve behavior.

This complements `/panel-review` and `blast-radius`. Panel review judges correctness and risk; blast-radius proves cross-boundary safety. Simplify removes unnecessary complexity in code already deemed acceptable to change.

## Scope selection

Establish scope before launching reviewers. Preserve unrelated user changes. Do not broaden beyond the selected scope unless needed to understand a pattern in scope.

1. If the user named an explicit scope (paths, symbols, a diff, or a natural-language area), use it.
2. Otherwise inspect local changes with both unstaged and staged diffs so staged work is not missed:

   ```bash
   git diff --no-color
   git diff --cached --no-color
   ```

   Treat the combined non-empty output as the scope.
3. If there is no local diff, use concrete files, symbols, or changes mentioned in the conversation.
4. If that also does not exist, fall back to the current `HEAD` commit:

   ```bash
   git show --stat --patch --no-color HEAD
   ```

For a scoped path list, limit diffs with path arguments. For untracked files in scope, read them explicitly; they have no diff until added.

## Prepare the scope bundle

Write a bounded bundle for reviewers under `.workspace/simplify/<run-id>/scope.txt` (gitignored). Include:

- scope summary (paths, revision range, or commit);
- combined diff for the scope (`git diff`, `git diff --cached`, or `git diff <base>...<head>` as appropriate);
- explicit untracked paths when they are in scope;
- any user intent from the request.

Keep the bundle under 2 MiB. If the diff is larger, include `git diff --stat` and `git diff --name-status`, then note which files reviewers should read with read-only tools.

## Parallel read-only reviewers

Launch three reviewers in the same turn, in parallel. They report findings only: no edits, formatters, commits, or worktrees.

Pi has no subagent tool in the main session. Use isolated headless Pi processes with an enforced read-only allowlist:

```bash
pi -p --no-session --no-extensions --no-skills --no-context-files \
  --tools read,grep,find,ls --model <provider/model[:thinking]> \
  "<review brief>" &
```

Use the session's active model for all three reviewers unless the user named a different model. Start all three commands, then `wait`. Do not rely on the prompt to prevent writes; the tool allowlist is the boundary.

Give each reviewer the scope bundle path, the scope summary, and the matching template below. Instruct reviewers to return only findings within scope, cite `path:line` or diff hunks, and make no writes. A reviewer with nothing worth reporting returns `No simplification findings.`

| Lens | Read this template | Focus |
| --- | --- | --- |
| Code quality | [`references/code-quality-reviewer.md`](references/code-quality-reviewer.md) | Complexity, dead code, weak types, unnecessary abstraction |
| Performance | [`references/performance-reviewer.md`](references/performance-reviewer.md) | Hot-path cost, repeated work, chatty I/O |
| Reuse | [`references/reuse-reviewer.md`](references/reuse-reviewer.md) | Existing helpers and house patterns to reuse |

Save each reviewer's stdout to `.workspace/simplify/<run-id>/<lens>.txt` when practical so fixes can reference them.

## Apply targeted fixes

Aggregate the three reports. Make fixes that reduce complexity or reuse existing patterns while preserving behavior.

- Prefer the smallest correct change.
- Skip issues that need additional user context or a much larger refactor than the scoped diff.
- Do not mix unrelated cleanup outside the selected scope.
- Do not change behavior to "simplify" unless the user asked for a behavior change.

After editing, run the most relevant lightweight checks for the touched files (unit tests, lint, typecheck) when practical. If checks are skipped or unavailable, say so.

## Output

Return a short summary:

1. **Scope** — what was reviewed.
2. **Fixed** — what you simplified and why it is safer or clearer.
3. **Skipped** — recommendations that need user input or a larger follow-up.
4. **Checks** — commands run and pass/fail, or why checks were not run.

Keep the summary proportional. The value is smaller, clearer code, not a long review lecture.

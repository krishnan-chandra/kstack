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

Launch all three reviewers in one `parallel_agents` tool call with `kind: "simplify"`. The extension shows the shared live agent pane with queued/running/completed state, model, elapsed time, current tool, and output preview. While the call is active, **Ctrl+Shift+V** opens the read-only transcript console and **Ctrl+Shift+X** aborts it. Do not replace it with background `pi` commands or a silent shell `wait`.

Use one task per lens. Use the session's active `provider/model[:thinking]` for all three reviewers unless the user named a different model. The tool runs every task from the repository root, enforces read/grep/find/ls-only isolation, disables extensions, skills, prompt templates, and context files, applies idle and runtime limits, and propagates cancellation.

Give each reviewer the scope bundle path, the scope summary, and the matching template below. Instruct reviewers to return only findings within scope, cite `path:line` or diff hunks, and make no writes. A reviewer with nothing worth reporting returns `No simplification findings.`

| Lens | Read this template | Focus |
| --- | --- | --- |
| Code quality | [`references/code-quality-reviewer.md`](references/code-quality-reviewer.md) | Complexity, dead code, weak types, unnecessary abstraction |
| Performance | [`references/performance-reviewer.md`](references/performance-reviewer.md) | Hot-path cost, repeated work, chatty I/O |
| Reuse | [`references/reuse-reviewer.md`](references/reuse-reviewer.md) | Existing helpers and house patterns to reuse |

After the tool returns, save each completed report to `.workspace/simplify/<run-id>/<lens>.txt` when practical so fixes can reference it. If one lens fails or aborts, continue with the completed reports and name the missing lens in **Skipped**; do not rerun an opaque wait or discard sibling findings.

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

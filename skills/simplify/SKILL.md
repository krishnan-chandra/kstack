---
name: simplify
description: Simplify scoped code changes with parallel read-only review lenses (code quality, performance, reuse), then apply targeted cleanup fixes. Use when the user says simplify, clean up, tighten, reduce complexity, remove dead code, or polish a diff; after implementing a feature or refactor; or when local changes feel over-engineered, repetitive, or harder to read than necessary.
license: MIT
compatibility: A repository checkout with git running inside Herdr. Primarily read-only review subprocesses; the parent may edit scoped files and run lightweight checks. Do not commit, push, or publish unless asked.
---

# Simplify

Reduce complexity in scoped code without changing behavior. Parallel read-only reviewers surface simplification opportunities in a dedicated Herdr tab; the parent applies only targeted fixes that preserve behavior.

This complements `/panel-review` and `blast-radius`. Panel review judges correctness and risk; blast-radius proves cross-boundary safety. Simplify removes unnecessary complexity in code already deemed acceptable to change.

## Guard and resolve paths

1. Run `test "${HERDR_ENV:-}" = 1`. Stop and explain that this skill requires a Pi session inside Herdr if the check fails.
2. Resolve this skill directory from the absolute path used to load `SKILL.md`. Set `KSTACK` to the directory two levels above it.
3. Never split or focus the user's pane. Reviewers run in a dedicated Herdr tab created by the fan-out tool.

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

Launch all three reviewers in one `cli.mjs fanout` call.

Use one task per lens. Use the session's active `provider/model[:thinking]` for all three reviewers unless the user named a different model. Reviewers run with read/grep/find/ls-only tools, disabled extensions, skills, prompt templates, and context files.

Write each lens prompt file under `.workspace/simplify/<run-id>/<lens>-prompt.md`. Include the scope bundle path, the scope summary, and the matching template below. Instruct reviewers to return only findings within scope, cite `path:line` or diff hunks, write their complete response to their assigned output file, and make no writes to the repository. A reviewer with nothing worth reporting writes `No simplification findings.`

| Lens | Read this template | Focus |
| --- | --- | --- |
| Code quality | [`references/code-quality-reviewer.md`](references/code-quality-reviewer.md) | Complexity, dead code, weak types, unnecessary abstraction |
| Performance | [`references/performance-reviewer.md`](references/performance-reviewer.md) | Hot-path cost, repeated work, chatty I/O |
| Reuse | [`references/reuse-reviewer.md`](references/reuse-reviewer.md) | Existing helpers and house patterns to reuse |

Compose `.workspace/simplify/<run-id>/spec.json`:

```json
{
  "owner": "simplify",
  "label": "<run-id>",
  "cwd": "<repo-root>",
  "tasks": [
    {
      "label": "code-quality",
      "model": "<model>",
      "cwd": "<repo-root>",
      "promptFile": ".workspace/simplify/<run-id>/code-quality-prompt.md",
      "outputFile": ".workspace/simplify/<run-id>/code-quality.txt",
      "access": "read-only",
      "tools": ["read", "grep", "find", "ls"],
      "noContextFiles": true,
      "timeoutMinutes": 15
    },
    {
      "label": "performance",
      "model": "<model>",
      "cwd": "<repo-root>",
      "promptFile": ".workspace/simplify/<run-id>/performance-prompt.md",
      "outputFile": ".workspace/simplify/<run-id>/performance.txt",
      "access": "read-only",
      "tools": ["read", "grep", "find", "ls"],
      "noContextFiles": true,
      "timeoutMinutes": 15
    },
    {
      "label": "reuse",
      "model": "<model>",
      "cwd": "<repo-root>",
      "promptFile": ".workspace/simplify/<run-id>/reuse-prompt.md",
      "outputFile": ".workspace/simplify/<run-id>/reuse.txt",
      "access": "read-only",
      "tools": ["read", "grep", "find", "ls"],
      "noContextFiles": true,
      "timeoutMinutes": 15
    }
  ],
  "maxConcurrency": 3
}
```

Run the fanout:

```sh
node "$KSTACK/extensions/shared/herdr/cli.mjs" fanout \
  --spec ".workspace/simplify/<run-id>/spec.json" \
  --out ".workspace/simplify/<run-id>/result.json"
```

Watch reviewers in the `simplify: <run-id>` tab. You or the user can inspect progress directly in each reviewer's pane.

Read the completed reports from `.workspace/simplify/<run-id>/<lens>.txt`. If one lens fails or aborts, continue with the completed reports and name the missing lens in **Skipped**; do not rerun an opaque wait or discard sibling findings.

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

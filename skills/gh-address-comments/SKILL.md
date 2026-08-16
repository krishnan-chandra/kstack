---
name: gh-address-comments
description: Address actionable GitHub pull-request review feedback. Use whenever the user asks to inspect unresolved review threads, requested changes, inline comments, or PR feedback, then implement selected fixes or draft responses. Uses the authenticated GitHub CLI and a bundled GraphQL query to preserve review-thread resolution state and inline locations.
license: Apache-2.0; see LICENSE.txt
compatibility: A git repository hosted on GitHub. Requires git and an authenticated GitHub CLI (gh) with network access.
---

# Address GitHub pull-request comments

Work through requested changes on a GitHub pull request. Treat thread-aware review data as a `gh api graphql` problem: flat PR comment reads do not preserve resolution state, outdated state, or complete inline context.

Run `gh` commands with network access. Confirm `gh auth status` before querying GitHub; if it fails, ask the user to authenticate with `gh auth login`.

## Workflow

1. Resolve the PR.
   - If the user gives a repository and PR number or URL, use them directly.
   - Otherwise, resolve the PR for the current branch with `gh pr view --json number,url,baseRepository`.
2. Inspect review context with thread-aware reads.
   - Fetch top-level comments and reviews with:

     ```bash
     gh pr view <number> --repo OWNER/REPO --json comments,reviews
     ```

   - Fetch thread-aware inline feedback with the bundled query. `--paginate` follows the query's `endCursor`, so do not remove `pageInfo` or rename that variable:

     ```bash
     gh api graphql --paginate --slurp \
       -F query=@<skill-dir>/references/review-threads.graphql \
       -F owner=OWNER -F repo=REPO -F number=<number> > /tmp/review-threads.json
     ```

   - For a current-branch PR, obtain `OWNER/REPO` and the number from `gh pr view --json number,baseRepository`.
   - Read the changed files and enough surrounding code to understand each inline comment in context.
3. Cluster actionable review threads.
   - Group comments by file or behavior area.
   - Separate actionable change requests from informational comments, approvals, already-resolved threads, outdated threads, and duplicates.
4. Confirm scope before editing.
   - Present numbered actionable threads with a one-line summary of the required change.
   - If the user did not ask to fix everything, ask which threads to address.
   - If the user asks to fix everything, interpret that as all unresolved actionable threads and call out any ambiguity.
5. Implement the selected fixes locally.
   - Keep every code change traceable to a review thread or feedback cluster.
   - If a comment asks for explanation rather than code, draft the response instead of forcing a code change.
6. Report the result.
   - List addressed threads, intentionally open threads, and supporting tests or checks.

## Write safety

- Do not reply on GitHub, resolve review threads, submit a review, commit, or push unless the user explicitly asks.
- Surface conflicting comments or a likely behavioral regression before editing.
- For ambiguous feedback, ask for clarification or draft a proposed response rather than guessing.
- Do not treat flat PR comments as a complete representation of review-thread state.
- If `gh` hits authentication or rate-limit errors, ask the user to re-authenticate and retry.

## Fallback

If the PR cannot be resolved, say whether the blocker is missing repository scope, missing PR context, or GitHub CLI authentication, and request the missing identifier or a refreshed `gh` login.

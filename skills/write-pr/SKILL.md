---
name: write-pr
description: Write and apply a crisp pull-request title and description from the branch diff. Use whenever the user asks to create, open, prepare, write, rewrite, refresh, or update a PR or its title/body. Update the open PR for the current branch; if none exists, push the branch as needed and create a draft PR. Organize the description by feature or behavior and give reviewers a thematic review guide rather than a file-by-file inventory.
license: MIT
compatibility: A git repository hosted on GitHub. Requires git and the authenticated GitHub CLI (`gh`).
---

# Write a pull request

Set the title and body of the current branch's open pull request. If the branch has no open PR, create a draft PR.

## Establish the PR and diff

1. Confirm that the current directory is a git repository, `gh auth status` succeeds, and the branch is neither detached nor the base branch. Stop on authentication, repository, or network errors rather than treating them as “no PR.”
2. Record uncommitted changes with `git status --short`. They are not part of the PR diff; mention them at the end instead of describing or committing them.
3. Find an open PR for the current branch with `gh pr view --json number,url,title,body,baseRefName,headRefName,isDraft`. If the command reports that no PR exists, prepare a new one. Do not replace a closed or merged PR.
4. For an existing PR, use its `baseRefName`. For a new PR, use `branch.<current>.gh-merge-base` when configured; otherwise query the repository's default branch with `gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name'`.
5. Inspect the complete committed change against the base:

```bash
git log --oneline <base>..HEAD
git diff --stat <base>...HEAD
git diff --name-status <base>...HEAD
git diff <base>...HEAD
```

Fetch the base ref first if it is unavailable or stale. Read enough surrounding code to understand behavior, not only changed lines. Check repository PR templates and a small sample of recent PR titles for local conventions. Treat commit messages and an existing PR body as clues, not truth; the diff is authoritative.

If the committed diff is empty, stop instead of creating or rewriting a misleading PR.

## Compose the title

Write one concrete sentence fragment that names the primary user-visible or developer-visible outcome.

- Follow the repository's established title pattern when one is clear.
- Prefer an imperative title such as `Add retry limits to archive uploads`.
- Keep it concise, normally under 72 characters. Do not end it with a period.
- Do not invent issue IDs, scope prefixes, performance claims, or behavior absent from the diff.

## Compose the body

Use this compact default structure, adapting required repository template sections when present:

```markdown
## Summary

- <most important behavior or capability>
- <second distinct outcome, if needed>

## Review guide

1. **<feature or behavior>** — <where to begin and what contract, flow, or decision to verify>
2. **<next feature or behavior>** — <where it connects and what deserves attention>
```

Group the write-up by feature, behavior, or runtime flow. A theme may cite a few paths or symbols as review anchors, but do not walk through every changed file. Order the review guide so that each step builds the reviewer's mental model: public contract or entry point first, implementation next, then integration, persistence, or edge cases.

Keep the body factual and easy to scan:

- Explain what changed and why when the diff provides evidence for the why.
- Name important compatibility constraints, migrations, risks, or intentional non-goals only when they matter.
- Include test evidence only when it is known. Never claim that tests passed because test files changed.
- Preserve still-relevant issue-closing references, required checklist items, warnings, and rollout notes from an existing body or repository template.
- Remove stale prose, generic benefits, exhaustive file lists, and sections that would be empty.
- Use plain language and project terms. A tired reviewer should know what to inspect and in what order.

Before applying the body, compare every claim with the diff. In particular, check that the summary covers all meaningful themes and that each review-guide step tells the reviewer what to verify, not merely which file to open.

## Apply the PR metadata

Write the body to a temporary file so shell quoting cannot corrupt Markdown.

For an existing PR:

```bash
gh pr edit <number> --title '<title>' --body-file <body-file>
```

For a new PR:

1. Push the current branch with `git push -u origin HEAD` if the commits are not on the remote. Creating the PR grants permission for this necessary push, but not for committing uncommitted work or force-pushing.
2. Create the PR explicitly as a draft:

```bash
gh pr create --draft --base <base> --head <current-branch> --title '<title>' --body-file <body-file>
```

Do not change draft state, reviewers, labels, assignees, milestones, or projects on an existing PR unless the user asks.

## Report the result

Return:

- whether the PR was created as a draft or updated;
- the final title;
- the PR URL; and
- any uncommitted changes omitted from the analysis.

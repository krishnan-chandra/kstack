---
name: find-reviewers
description: Recommend the 2-5 best pull-request reviewers for a git change (PR branch, diff range, or set of changed paths) by analyzing commit history, CODEOWNERS, adjacent-domain ownership, and author identities, returning a prioritized, evidence-backed list with a recommended review order. Use whenever the user asks "who should review this", "best reviewers for this PR/branch", "recommend reviewers", "who owns this code", "who knows this area", or asks for review assignments or reviewer suggestions for any change, even if they don't say "reviewer" explicitly and even in repos without CODEOWNERS.
license: MIT
compatibility: Any git repository. Requires bash, git; python3 for precise CODEOWNERS matching (falls back gracefully without it). Read-only — never mutates the repo.
---

# Find reviewers

Given a change — a PR branch, a diff range, or a list of changed paths — find the 2–5 people best equipped to review it, and return a prioritized, evidence-backed recommendation with a review order.

Read-only: only run non-mutating git commands. Never commit, push, checkout, or modify anything in the analyzed repo.

## Inputs

Establish three things, asking only if they cannot be inferred:

1. **The repo** — default to the current working directory.
2. **The change** — a range like `origin/main...HEAD` (default: current branch vs its base), or an explicit list of changed paths.
3. **The PR author** — usually the author of the range commits; they are excluded from recommendations (you don't review your own PR).

## Workflow

### 1. Gather signals with the bundled script

Resolve this skill's directory and run:

```bash
bash <skill-dir>/scripts/analyze_reviewers.sh \
  --repo <repo> --range '<base>...<head>' [--paths p1,p2,...] [--recent-months 12] [--top 6]
```

It prints six sections: changed files, change authors, per-file authorship (all-time + recent commit counts), matching CODEOWNERS rules, parent-directory authorship, and identity variants. Do not reinvent this plumbing with ad-hoc git commands; if the script fails, fall back to the equivalent commands in [references/heuristics.md](references/heuristics.md).

### 2. Merge identities before counting

One person often commits under several names and emails (`jane <jane@acme.dev>`, `Jane Doe <jane.doe@gmail.com>`, …). Section 6 lists detected variants; merge counts across variants of the same person. Unmerged identities split credit and silently demote the real owner — this is the most common way reviewer recommendations go wrong. When in doubt (e.g. two people sharing a first name), do not merge.

### 3. Score candidates on five signal groups

For each candidate, weigh — in roughly this order:

1. **Direct file ownership**: commits to the changed files themselves. Recent commits (script's `recent` counts) matter far more than ancient ones — ownership decays as code is rewritten.
2. **Policy ownership**: CODEOWNERS rules matching the changed paths (the script flags last-match-wins overrides). Team entries (`@org/team`) mean "someone from this team"; say so and pick the member with the strongest history signals.
3. **Adjacent-domain ownership**: whoever built the infrastructure the change sits on. A new seeder is best reviewed by the seeder-framework author even if they never touched the new file. Look at parent-directory counts, and if the diff imports or extends specific modules, run the script again with `--paths` on those modules, or check `git log --format='%an <%ae>' --since='6 months ago' -- <module>` directly.
4. **Product-intent ownership**: whoever most recently implemented the behavior this change extends (check `git log --since='6 months ago' --format='%an %ad %s' -i --grep='<feature keyword>'` or the files implementing it). They judge whether the change satisfies intent, which mechanical review cannot. When this signal is strong — they shipped the relevant behavior within the last few months — they belong in the main recommendation list, not on the bench: intent mistakes are exactly what the other reviewers miss.
5. **`git blame` on hot lines** (only if a specific risky line is at stake): `git blame -L <start>,<end> -- <file>`.

### 4. Rank and order 2–5 reviewers

Pick the smallest set that maximally covers the changed surface — 2–5 people, never more. Order them so the most load-bearing review happens first:

1. mechanics/direct ownership first (they catch correctness and style in the diff itself),
2. then the domain-contract owner (they catch integration and framework violations),
3. then product intent (they catch "this isn't what we wanted").

A reviewer who only shows up through weak signals (single old commit, broad CODEOWNERS team) belongs lower or not at all. Conversely, do not demote a strong product-intent owner just because they never touched the diff's files — their signal is about the behavior, not the lines.

### 5. Be honest about weak signals

If the signals are thin — brand-new files with no history, a repo with one or two contributors, empty sections — say so explicitly instead of dressing up a guess. Then fall back, in order: CODEOWNERS → the PR author's own suggestions (ask if not given) → general commit activity in the repo. A single-contributor repo has no valid reviewer: say that plainly and suggest external review or pair review. See [references/heuristics.md](references/heuristics.md) for edge cases.

## Output format

Return exactly this structure (adapt counts/wording, keep the fields):

```markdown
# Reviewers for <branch-or-change> (base: <base>)

## Recommended reviewers

### 1. <Name> (@<github-handle>) — <one-line role, e.g. "owner of the seeder framework">
- **Evidence**: <files they own with commit counts, e.g. "platform/seeders/src/index.ts: 7 commits (all recent)"; CODEOWNERS rules; blame hits>
- **Why them for this change**: <what they can judge that others can't>
- **Review focus**: <what to ask of them>

### 2. ...

## Review order
1. <Name> — <what they clear first>
2. <Name> — <what they check next>
...

## Signal quality
<what was strong, what was weak, identities merged, anything uncertain>
```

GitHub handles come from CODEOWNERS entries (individual owners like `@someuser` are handles — check every matching *and nearby* rule, since handles often appear on sibling paths), `@handle` mentions in the repo, or the email/local context; if a handle is genuinely unknown, write `(handle unknown)` rather than guessing.

## Bounded effort

On large repos, cap the work: analyze at most ~15 changed files in detail (group the rest by directory), at most 6 parent directories, and stop once 4–5 candidates clearly cover the surface. The goal is a good recommendation, not an exhaustive census.

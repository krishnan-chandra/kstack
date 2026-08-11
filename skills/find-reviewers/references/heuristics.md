# Reviewer heuristics — extended reference

Extended guidance for `find-reviewers`. Read this when the bundled script fails, when signals are weak or contradictory, or when the change has unusual shape (refactor, revert, dependency bump, brand-new subsystem).

## Table of contents

- [Raw git equivalents of the script](#raw-git-equivalents-of-the-script)
- [Identity mapping](#identity-mapping)
- [Recency weighting](#recency-weighting)
- [CODEOWNERS semantics](#codeowners-semantics)
- [Adjacent domains and product intent](#adjacent-domains-and-product-intent)
- [Ranking and review order](#ranking-and-review-order)
- [Weak-signal fallbacks](#weak-signal-fallbacks)
- [Unusual change shapes](#unusual-change-shapes)

## Raw git equivalents of the script

If `scripts/analyze_reviewers.sh` cannot run (no bash, restricted environment), reproduce its sections:

```bash
git diff --name-only <base>...<head>                        # changed files
git log --format='%an <%ae>' --no-merges <base>..<head>     # change authors
git log --format='%an <%ae>' --no-merges -- <path>          # per-file owners
git log --format='%an <%ae>' --no-merges --since='12 months ago' -- <path>
git log --format='%an <%ae>' --no-merges -- <parent-dir>    # adjacent domain
git log --follow --format='%an <%ae>' -- <renamed-file>     # history across renames
git blame -L <a>,<b> -- <file>                              # hot-line ownership
git log --all --format='%an <%ae>' | sort | uniq -c | sort -rn   # identity census
```

Choose the base conservatively: `origin/main`, else `main`, else `master`; if the branch was cut from another branch, use that fork point (`git merge-base <base> HEAD` is what `A...B` diff already resolves).

## Identity mapping

- Merge variants of one person before comparing totals. Strong merge evidence: identical email, identical name with different emails, `name <email>` pairs that interleave in `git log`, noreply addresses (`<id>+<login>@users.noreply.github.com` ↔ `<login>`).
- First-name-only matches are a hint, not proof — two people can share a first name. When counts are close and the merge is doubtful, keep them split and mention the uncertainty.
- Machine/agent identities (e.g. `dependabot[bot]`, `renovate[bot]`, CI bots) are never reviewers; exclude them.
- If a variant identity used a *shared* team email, trust the name on the commit, not the email.

## Recency weighting

Commit counts decay: a file rewritten six months ago transfers ownership to whoever rewrote it. Treat the last ~12 months as "current ownership" and everything older as "institutional knowledge". Concretely:

- Recent top committer beats all-time top committer when they differ.
- Someone whose only commits are >2 years old is a fallback reviewer ("they built the original; ask them for context"), not the primary.
- If the script's `recent` and `all-time` lists disagree sharply, that itself is evidence of a recent rewrite — worth one sentence in the report.

## CODEOWNERS semantics

- Locations, in precedence order: `.github/CODEOWNERS`, root `CODEOWNERS`, `docs/CODEOWNERS`, `.gitlab/CODEOWNERS`.
- Patterns are gitignore-style; **last matching rule wins**. A rule on `src/api/` overrides a broader rule on `src/` for that subtree. The script marks overridden rules — do not recommend owners from overridden rules.
- Matching details: `*` and `?` never cross `/` (`/src/*.test.ts` does not own `src/deep/x.test.ts`); `**` crosses directories; a pattern containing a slash is anchored to the repo root (`docs/*` does not own `other/docs/x`); a pattern without a slash matches at any depth.
- A pattern naming a directory — with a trailing slash, or with no glob characters at all (`/platform`) — owns that directory **and everything beneath it**. Individual owners listed as `@handle` in any matching or sibling rule are a good source of GitHub handles.
- Team owners (`@org/team`) are policy pointers, not people. Resolve them with history signals: the team member with the most recent commits to the matched paths is the practical reviewer. Say that you resolved a team to a person.
- A path with no matching rule inherits nothing beyond repo-wide rules; don't invent owners from CODEOWNERS silence.

## Adjacent domains and product intent

The person who wrote the most lines *in the diff* wrote them as part of this change — their authority ends where the framework begins. Find the substrate:

- Look at what the diff imports/extends, then run the script with `--paths` on those files, or `git log` the module directory.
- Product intent: identify the feature the change extends ("delegated sessions", "partner roles", …) and find its most recent implementer:
  ```bash
  git log --since='6 months ago' --format='%an <%ae> %ad %s' -i --grep='<feature keyword>'
  ```
  That person judges whether the change does what it should, which mechanical review misses.
- For cross-cutting changes (schema + API + UI), prefer one reviewer per layer over three reviewers from one layer.

## Ranking and review order

Coverage first, then load-bearing order:

1. Choose 2–5 people who together cover every changed area; drop anyone whose area is already covered by a stronger candidate.
2. Order: mechanics/direct ownership → domain/framework contract → product intent. The first reviewer should be able to approve the diff on its own merits; later reviewers add layers of judgment.
3. Prefer reviewers with *recent* engagement — an active owner reviews faster and with current context.
4. Balance load: if one person owns everything, still add a second reviewer for bus-factor and knowledge spread, and say why.

## Weak-signal fallbacks

Escalate honestly; never fabricate evidence:

1. **New files, no history** → parent-directory owners + CODEOWNERS + authors of files the new code imports.
2. **Single-contributor or tiny repo** → say there is no independent reviewer from history; suggest the PR author's own nominations, pair review, or external review. Do not recommend the author to themselves.
3. **Squashed/shallow history** (`git log` shows few commits) → CODEOWNERS, directory structure, and ask the user who works in this area.
4. **All candidates are the PR author** → say so plainly; recommend splitting the change or an outside reviewer.

## Unusual change shapes

- **Refactors/moves**: use `git log --follow`; ownership of the *old* path counts.
- **Reverts**: the author of the reverted commit is the most important reviewer — they know what breaks.
- **Dependency bumps / lockfiles**: CI/config owners from CODEOWNERS plus whoever last touched the dependency's usage sites.
- **Generated files**: skip them as review surface; review the generator instead.
- **Test-only changes**: owners of the code under test, not only owners of test files.

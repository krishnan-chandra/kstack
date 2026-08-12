---
name: why
description: Investigate why code or a product decision exists. Use for "why does X work this way", "why did we choose Y", design rationale, regressions, archaeology, postmortems, and history before changing code. Separates direct evidence from inference and reports searched gaps. Use `how` for runtime behavior. Delegated investigation runs only allowlisted fast models.
license: MIT
compatibility: Git repository access; optional MCP integrations; Pi CLI and an allowlisted model in kstack.json.
---

# Why

Find the evidence behind a decision without inventing a satisfying story. Code can show what the system does, but it rarely proves why someone chose it. Keep direct evidence, inference, contradictions, and missing records separate.

Use [`how`](../how/SKILL.md) when the user needs a runtime trace or architecture explanation rather than intent.

## Use only fast investigation models

All delegated work for this skill runs through kstack's shared `investigation` allowlist. Do not substitute the active model, a user-named heavyweight model, or a model from another kstack section. In particular, do not use Sol, Fable, Opus, or another reasoning model for investigation or synthesis. This skill optimizes for a quick, evidence-backed answer.

From this skill directory, resolve the model before every delegated run:

```bash
node ../investigation-model.mjs [--model provider/model]
```

The command prints a `pi --model` value and rejects models that are not in `investigation.allowedModels` in `$PI_CODING_AGENT_DIR/kstack.json` (default `~/.pi/agent/kstack.json`). If the user requests an unlisted model, explain the restriction and offer an allowlisted one. Never bypass the resolver. A skill cannot change the interactive session's model, so use that model only to frame the question, launch work, check citations, and present the result.

## 1. Establish a code anchor

Identify the target's path, symbols, and relevant lines. Then collect compact source-control context:

```bash
git blame -L <start>,<end> <file>
git log --follow --oneline -20 -- <file>
git log -p -- <file>
```

For relevant commits, inspect the full message and linked pull request or issue when available. Do not scan unrelated repository history or private session archives. If the target is ambiguous, state the interpretation and continue with the most likely anchor.

## 2. Search the highest-value evidence in parallel

Resolve one allowlisted model. Start with source control and only the external evidence categories that are available and plausibly connected to the target:

- pull requests, commits, code comments, and tests;
- tickets and project tracking;
- RFCs, design documents, and incident reports;
- team chat; and
- observability, error tracking, or product analytics for a runtime or product question.

Launch at most three focused investigators in parallel. Give each one evidence category, exact query terms, the code anchor, and the original question. Each investigator returns citations, empty searches, contradictions, and no conclusions unsupported by its source. Keep the child read-only in practice: it must not edit files, create tickets, post messages, or mutate external systems.

Use the resolved model in every child command. A typical source-control run is:

```bash
MODEL="$(node ../investigation-model.mjs)"
pi -p --no-session --no-extensions --no-skills --no-context-files --model "$MODEL" "
Investigate why <target> exists. Read only. Use this code anchor: <paths, symbols,
commits>. Search source-control and linked PR or issue evidence for <question>.
Return direct quotes or precise citations, null searches, contradictions, and clearly
labeled inferences. Do not infer intent from code alone. Do not edit or publish anything.
"
```

Keep extensions enabled only for an investigator that needs a named MCP. Before using an MCP, discover its tool and inspect its schema. Query only the target, symbols, linked IDs, author, and time window justified by the code anchor. If no matching source is available, report that gap rather than broadening the search.

For a simple, well-documented change, one source-control investigator is enough. For a thin or disputed record, use the full three-worker budget. Do not add a heavyweight judge. Reconcile workers in the parent by spot-checking their citations.

## 3. Report calibrated evidence

Return this shape:

```markdown
## Question and anchor
<Question, target symbols, and `path:line`.>

## Direct evidence
- <Claim> — <commit, PR, issue, document, or other citation with a short quote.>

## Reasonable inferences
- <Hedged conclusion> — <why the cited evidence supports it but does not prove it.>

## Contradictions and gaps
- <Conflicting evidence, searched source with no result, or unavailable source.>

## Sources consulted
- <Source>: <query or scope>; <finding, no relevant result, or unavailable>.

## Change constraints
- Preserve: <established constraint, if the user is preparing a change>.
- Avoid: <risk or unknown that should not be silently removed>.
```

Omit **Change constraints** unless the question prepares for a code change. Cite every direct claim. Use "appears," "likely," or "we could not determine" for inference and gaps. Do not turn a null search into proof that no rationale exists.

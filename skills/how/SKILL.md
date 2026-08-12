---
name: how
description: Explain how code, a subsystem, or a runtime flow works. Use for "how does X work", code walkthroughs, ownership or placement questions, architecture overviews, and onboarding mental models. Use `why` for historical intent and decision rationale. Delegated exploration runs only allowlisted fast investigation models.
license: MIT
compatibility: Pi CLI and an allowlisted model in kstack.json.
---

# How

Build a working mental model of code without turning a walkthrough into a slow design review. This skill answers behavior, structure, ownership, and runtime flow. It does not infer historical motivation from code. Route questions about intent, tradeoffs, or old decisions to [`why`](../why/SKILL.md).

## Use only fast investigation models

All delegated work for this skill runs through kstack's shared `investigation` allowlist. Do not substitute the active model, a user-named heavyweight model, or a model from another kstack section. In particular, do not use Sol, Fable, Opus, or another reasoning model for exploration or synthesis. The fast response is the product.

From this skill directory, resolve the model before every delegated run:

```bash
node ../investigation-model.mjs [--model provider/model]
```

The command prints a `pi --model` value. It rejects a requested model unless it appears in `investigation.allowedModels` in `$PI_CODING_AGENT_DIR/kstack.json` (default `~/.pi/agent/kstack.json`). If the user asks for a model outside that list, explain that this skill only uses the configured fast allowlist and offer the listed models. Never bypass the resolver. The main interactive model cannot be changed by a skill; keep its work to framing, launching, and presenting the delegated result.

## 1. Frame the question

State the interpretation in one sentence when the target is ambiguous, then proceed. Identify:

- the question to answer;
- the code entry point, user action, or symbol; and
- whether the scope is **narrow** (one module or call chain) or **broad** (a subsystem or cross-package flow).

Do not ask a clarification question when repository evidence can resolve the ambiguity. Do not inspect unrelated code.

## 2. Explore on the allowlisted model

Resolve one model and use it for every run. A user may select a different model only with `--model provider/model` passed to the resolver, and only if it is allowlisted.

For a narrow question, launch one investigator:

```bash
MODEL="$(node ../investigation-model.mjs)"
pi -p --no-session --no-extensions --no-skills --no-context-files --model "$MODEL" "
Read only. Explain how <target> works in <repository>. Trace the concrete path from
<entry point> through state and decision points to the observable effect. Read source,
not just names. Return: overview, flow, key symbols with path:line, ownership, and
gotchas. Do not edit files, run mutations, or infer historical intent.
"
```

For a broad question, launch two or three independent investigators in parallel. Split by real seams, such as entry path, state and data flow, and configuration or integration boundaries. Use the same resolved model for all workers. Each brief must name its slice, require `path:line` evidence, and forbid edits. Do not fan out for a single call chain.

After the workers return, make a short parent synthesis from their evidence. Do not launch a heavyweight synthesizer. Reconcile contradictions by reading the cited source yourself. If the answer remains uncertain, say what path or boundary is not established.

## 3. Return an explanation

Use only the sections that help answer the question:

```markdown
## Overview
<What the component does and its boundary.>

## Flow
1. <Trigger and each material step, with `path:line` citations.>

## Key concepts and ownership
- `<symbol>` — <role and owner>, `path:line`.

## Where to start
- `<path>` — <why it matters>.

## Gotchas
- <Non-obvious behavior, invariant, or unresolved gap.>
```

Keep the explanation concrete and concise. Link implementation facts to `path:line`. Label a conclusion as uncertain when the trace does not establish it. End with a direct recommendation only if the user asked an ownership or placement question.

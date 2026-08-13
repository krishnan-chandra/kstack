---
name: recall
description: Reconstruct recent working context across Pi sessions — what was attempted, what landed, what was rejected, and the concrete resume point — reconciled against live Git, worktree, and PR state. Use for "recall my work on X", "catch me up", "what have I been working on", "where did I leave off", or before starting or resuming work. Read-only. Delegated mining runs only allowlisted fast investigation models.
license: MIT
compatibility: Pi CLI and an allowlisted model in kstack.json; the session-archive extension for archived-session search.
---

# Recall

Rebuild the user's recent working context across sessions and hand back a tight brief: where things stand now and what to do next. Keep it on-topic. Read only what the in-scope threads need, then stop. Heavy reading fans out to parallel delegated miners; the main thread keeps only their findings and the final brief.

Two records hold the context. The user's own session history holds what they did and decided. The shared record — source control, PRs, issues, docs — holds what happened around the same code under other names, and what landed or was reverted after the sessions ended. Reconstruct from both, then verify against live state. A transcript claim is history, not current truth.

## Routing

- One specific prior session to resume, or the immediately linked `/handoff` parent: use the `session-pickup` router route or the `read_handoff_history` / `search_handoff_history` tools directly, not this skill.
- Turning habits into durable preferences: [`personalize`](../personalize/SKILL.md).
- Extracting lessons from one completed session: [`reflect`](../reflect/SKILL.md).
- The user already gave a full state capsule (paths, branch, the change): use it and skip the mining.

Recall loads working context across **several** relevant sessions before acting.

## Use only fast investigation models

All delegated work for this skill runs through kstack's shared `investigation` allowlist. Do not substitute the active model, a user-named heavyweight model, or a model from another kstack section. In particular, do not use Sol, Fable, Opus, or another reasoning model for mining or synthesis. From this skill directory, resolve the model before every delegated run:

```bash
node ../investigation-model.mjs [--model provider/model]
```

The command prints a `pi --model` value and rejects models not in `investigation.allowedModels` in `$PI_CODING_AGENT_DIR/kstack.json`. If the user requests an unlisted model, explain the restriction and offer an allowlisted one. Never bypass the resolver.

## 1. Lock the scope before searching

Pin and state back:

- the window — "recent" is a real range, default the last 7 days;
- the topic, if named; and
- the workspace — default the current working directory (`cwd` filter); never read another project's sessions without being asked.

Never quietly turn "all" into "recent N". If the user said "everything", say what that covers before searching.

## 2. Mine the session corpus

Pi sessions live as JSONL in `$PI_CODING_AGENT_DIR/sessions/<slug>/` (active) and, once archived, under `$PI_CODING_AGENT_DIR/archive/sessions/YYYY/MM/<uuid>/session.jsonl`, searchable through the `search_session_archive` and `read_session_archive` tools.

For one or two candidate sessions, search directly with `search_session_archive` and the built-in `grep` tool — no fan-out. For a broader recall, resolve one allowlisted model and launch up to three parallel miners, each with a slice (by time window or by topic keyword set):

```bash
MODEL="$(node ../investigation-model.mjs)"
pi -p --no-session --no-skills --no-context-files --model "$MODEL" \
  --tools read,grep,find,ls,search_session_archive,read_session_archive "
Read only. Mine Pi session history for work on <topic> in <cwd> during <window>.
Search the archived index with search_session_archive (FTS5: words, \"quoted
phrases\", AND/OR/NOT, prefix*) and grep active sessions under
$PI_CODING_AGENT_DIR/sessions/--<cwd-slug>--/ with the grep tool. Order
candidates by real modification time, never by UUID. Grep the topic first, then
read only the matching sessions and only their relevant regions.

Two storage paths, two readers — never mix them:
- Archived sessions: page entries with read_session_archive by exact session id.
  It rejects anything not in the archive index.
- Active sessions: read the JSONL files directly with grep/read. Never pass an
  active session id to read_session_archive.

Skip the current session and obvious eval/test sessions. Prefer user corrections
and final outcomes over abandoned intermediate claims. Do not edit, move, or
archive anything.
Return one block per relevant session: session id, topic, the user's goal,
decisions, open threads, struggles and corrections, and artifacts (commits,
PRs, branches, worktrees). Cite the session id for every claim; report searched
queries with no result.
"
```

The `--tools` allowlist is the read-only boundary, not the prompt: miners get `read`, `grep`, `find`, `ls`, and the two read-only archive tools — no `bash`, no `write`, no `edit`. This matters because miners consume untrusted historical transcript content, and the session-archive threat model states that an agent with shell access can modify or delete archive data despite the extension's accident guards. Extensions stay enabled so the archive tools exist; the raw transcripts stay in the miners and the main thread gets only their findings.

## 3. Sweep the shared record when the topic names a target

When the topic names a feature, file, subsystem, or bug, sweep the shared record in parallel with the mining. This is the default, not a judgment call: a named target carries history the user's own sessions never show — fixes that shipped and were reverted, review outcomes, linked issues.

Reuse the [`why`](../why/SKILL.md) skill's source investigators, but steer the question from "why was this built" to "what is the current state, what was tried and did not hold, and what is still open". Run `git log --oneline -- <paths>`, `gh pr list` / `gh pr view`, and issue searches. One investigator per source, null results are findings, unavailable sources are reported as gaps.

Skip this step only for pure activity recall with no named target ("what did I do this week").

## 4. Reconcile against live state

Take the branches, commits, PRs, and worktrees the mining surfaced and check them now:

```bash
git status --short && git branch --show-current
git log --oneline -10
gh pr list --author @me --state all --limit 10
gh pr view <N> --json state,mergeable,reviews,statusCheckRollup
```

For kstack-managed work, also inspect `~/.pi/kstack/worktrees/` records and decision-trail logs named in the findings. Where a transcript claim and live state disagree, live state wins and the disagreement is reported.

## 5. Write the brief

Lead with the capsule, then thread status, then problems, then the next move. Group by thread. Stay on the named topic.

- **Capsule.** At most 5 bullets. What this work is and where it stands overall.
- **Threads.** One line each, each prefixed with exactly one status tag: `[merged #N]`, `[open PR #N]`, `[in flight <branch>]`, `[verified, uncommitted]`, `[reverted #N]`, or `[planned, not started]`. A thread with no tag is not done yet, so tag it.
- **Problems.** At most 5, the recurring ones: struggles and corrections from the sessions, plus anything that shipped and was reverted, so the next attempt starts where the last one failed.
- **Next move.** The single most useful next action, concrete.
- **Evidence.** Session IDs, commits, and PRs behind the claims above.

An adjacent thread stays out unless it blocks this one. When the capsule and thread lines outgrow a screen, cut detail before cutting threads. Run the prose through [`unslop`](../unslop/SKILL.md) before presenting. Stay read-only end to end: recall never edits code, moves sessions, or mutates the archive.

**Reply:** the brief, to the contract above.

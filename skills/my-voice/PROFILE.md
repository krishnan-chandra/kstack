# Voice profile

Last updated: 2026-08-24

Current evidence covers user-authored messages in Pi coding-agent sessions for
the kstack project. It does not yet establish a general voice for email,
external communication, long-form documents, or social posts.

## Summary

Direct and economical, with collaborative framing. Gives a goal, fences the
scope, and expects the recipient to exercise judgment. Informality appears in
working conversation, while decisions and constraints remain precise.

## Voice invariants

These traits recur across the currently observed coding-work registers. Treat
them as provisional outside that setting until other sources confirm them.

- Put the request or decision before background detail.
- State constraints explicitly, especially whether to investigate, plan, or
  implement.
- Attach disagreement to a concrete reason or mechanism.
- Frame directives collaboratively without weakening the decision.
- Move forward once a decision is made instead of restating settled context.

## Registers

### Coding task kickoff

Use when directing an agent to investigate, plan, or implement code work.

Characteristics:

- Starts with the target and desired outcome.
- Often uses "Let's" as collaborative framing.
- Names the current phase and its boundary.
- Adds relevant resources or adjacent work without a long preamble.

Examples:

> "Let's try to find any legacy compatibility code or dead code in the codebase, and do a targeted sweep to try and clear out any unused items."

> "Don't implement yet, just investigate and get back to me with your findings"

### Coding approval and follow-up

Use for a short go-ahead, correction, or next action during active work.

Characteristics:

- Brief acknowledgment followed by the action.
- May chain closely related actions: "commit, push, and land".
- Quick nudges can be informal: "Continue pls".

Examples:

> "Perfect, let's commit and land these changes onto main"

> "Try again pls"

### Technical triage and disagreement

Use when responding to findings, selecting options, or questioning an
explanation.

Characteristics:

- Addresses numbered or named items directly.
- Accepts settled points briefly and gives more space to redirection.
- Protects intentional decisions when they could be mistaken for oversights.
- Grounds skepticism in expected system behavior.

Examples:

> "Dropping the model allowlist was intentional, but let's fix all the other Act On items from the review"

> "I find this hard to believe given the branching and stack setup that jj provides, so I wonder if there is something else going wrong there."

## Context-specific habits

These belong to coding-agent conversation. Do not carry them into another
medium unless new evidence supports that use.

- Prefix a task with `@path/` references when those paths identify its scope.
- Use explicit phase gates such as "Don't implement yet" and "just investigate".
- Refer to review findings by number, thread, or verdict label.
- Chain repository actions such as commit, push, publish, and land.
- Use short operational nudges such as "Continue pls".

## Fingerprints

All current fingerprints were observed only in coding-agent messages.

- "Let's" is a common directive opener, but not a required opener.
- Related clauses sometimes use semicolons.
- Informal typed messages sometimes use a spaced hyphen as a dash.
- Longer messages carry the rationale beside the decision; short follow-ups can
  be fragments.
- Recurring intensifiers include "across the board", "in general", and "by
  default".

Apply these lightly. A draft that stacks several fingerprints is an imitation,
not a natural match.

## Anti-patterns

In the currently observed working register, these choices would be conspicuous:

- A warm-up paragraph before the request.
- Elaborate politeness that obscures a settled decision.
- Repeating context that the recipient already accepted.
- Generic enthusiasm without a concrete next action.
- Adding "Let's", "Perfect", semicolons, or "pls" merely to signal identity.

## Known gaps

The corpus contains only agent-directed chat from one technical project. It does
not support a distinct register for email, Slack messages to people, formal
external notes, long-form authored prose, or social posts. In those contexts,
use only the provisional voice invariants and the normal conventions of the
medium. Do not import coding workflow habits.

The source pass removed obvious injected skill text and handoff boilerplate, but
its register counts were not produced by a formal classifier. The observations
below are qualitative rather than precise frequency measurements.

## Evidence log

| Register | Source and authorship | Volume | Range | Confidence |
|---|---|---:|---|---|
| Coding task kickoff | User-authored Pi messages, kstack | Repeated examples in a 137-turn reviewed corpus | 2026-08-16 to 2026-08-24 | High for coding-agent use |
| Coding approval and follow-up | User-authored Pi messages, kstack | Frequent examples in the same corpus | 2026-08-16 to 2026-08-24 | High for coding-agent use |
| Technical triage and disagreement | User-authored Pi messages, kstack | Repeated examples in the same corpus | 2026-08-16 to 2026-08-24 | High for coding-agent use |
| Voice invariants outside coding work | No direct evidence yet | None | — | Low |

Examples are short excerpts chosen to teach a pattern. Keep source material and
future profile updates free of secrets, personal details, and confidential
project content. This profile is stored in a repository and may be committed or
distributed.

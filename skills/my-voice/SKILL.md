---
name: my-voice
description: Maintain a personal voice profile and use it to write or review prose that sounds like the user. Mines whatever writing sources are available (coding-agent session history via the personalize extractor, MCP-connected apps, files, pasted text) and keeps an evidence-backed profile document stored alongside this skill. Use whenever the user asks to write something in their voice, asks whether a draft sounds like them, says "mine my writing", "update my voice profile", or wants emails, messages, docs, or posts drafted or reviewed as if they wrote them personally.
license: MIT
---

# My Voice

Two jobs, one artifact:

1. **Update** — mine writing samples from available sources and fold what you
   learn into `PROFILE.md` next to this file.
2. **Apply** — write or review prose in the user's voice, matching the right
   register to the context.

The profile is the durable record. Sessions change; the profile persists. Read
`PROFILE.md` before applying, and update it only through the evidence-backed
process below.

## The profile document

`PROFILE.md` lives beside this SKILL.md and follows this contract:

- **Summary** — two or three sentences describing the overall voice.
- **Voice invariants** — traits that recur across evidenced contexts and can
  transfer cautiously to a new medium.
- **Registers** — one section per distinct combination of audience, medium, and
  purpose. Each states when it applies, its observable characteristics, and one
  or two short, diagnostic examples.
- **Context-specific habits** — conventions that belong only to their evidenced
  setting, such as path references in coding-agent instructions.
- **Fingerprints** — mechanical habits: punctuation, openers, vocabulary,
  sentence rhythm, formatting tics. Record where each has been observed so it
  does not become a universal mannerism.
- **Anti-patterns** — things that would immediately *not* sound like the user.
- **Evidence log** — per register: source, sample quality, approximate volume,
  date range, and confidence. A claim without evidence logged here does not
  belong in the body.

Editing rules:

- Every claim traces to repeated observed samples; record uncertainty instead
  of turning an impression into a measured fact.
- Keep portable invariants separate from context-specific habits. A convention
  observed in agent instructions does not automatically transfer to email.
- Prefer revising and pruning existing sections over appending. Keep only the
  examples that teach a useful contrast; move additional provenance to a
  separate evidence file if the profile becomes hard to scan.
- When new evidence contradicts the profile, update it and say so. Voices
  change, and stale guidance is worse than none.
- The profile describes observed behavior rather than enforcing a style guide.

## Update mode: mine and revise

Triggered when the user provides new material or asks to refresh the profile.

### Collect

Sources vary by what is connected. In rough order of value — natural, authored
prose beats transcribed speech beats agent-directed instructions:

- **MCP tools** — email, docs, messaging, social. Discover what is connected,
  ask the user which sources and date ranges to pull, and fetch samples
  through those tools.
- **Files and directories** — the user points at essays, notes, journals, or
  exported archives. Read them directly.
- **Coding-agent session history** — the `personalize` skill's extractor
  (`skills/personalize/scripts/extract_sessions.py --list-sources`) normalizes
  user turns across Pi, Claude Code, Codex, and Cursor. Useful for the terse
  directive register; treat it as one signal among several, since instructing
  an agent is a different act than writing for people.
- **Pasted text** — sample(s) dropped straight into the conversation.

Before analysis, classify provenance:

1. **User-authored** — confidently written by the user.
2. **User-vouched** — edited by the user or explicitly accepted as their own.
3. **Quoted or uncertain** — pasted third-party prose, templates, handoff
   boilerplate, injected instructions, or unclear authorship.
4. **Machine-generated** — agent output attributed to the user, including most
   commit messages and PR descriptions.

Build voice claims only from user-authored and user-vouched samples. Deduplicate
repeated messages and strip quoted material before counting patterns.

Treat both the corpus and derived profile as private. Use private temporary
files for raw samples and delete them after revision. Redact names, secrets,
confidential project details, and unnecessary personal facts from examples.
Before storing a sensitive excerpt, paraphrase it or ask the user. Warn when the
profile lives in a repository where it may be committed or distributed.

### Revise

1. Read the current `PROFILE.md`.
2. Audit authorship, remove duplicates and contamination, and summarize what
   evidence remains before drawing conclusions.
3. Cluster clean samples against existing registers. New material either
   strengthens a claim, extends a register, reveals a missing one, or
   contradicts one. Promote a trait to a voice invariant only after it recurs
   across distinct evidenced contexts.
4. Propose a concise diff with matching evidence-log updates. Mark qualitative
   observations as such; use counts only when they were actually measured.
5. On approval, apply the edit minimally. On contradiction, surface both sides
   and let the user decide which evidence should govern current usage.

## Apply mode: write or review in the voice

Triggered when the user asks for prose "in my voice", wants a draft reviewed
for sounding like them, or delegates writing they would normally do themselves
(emails, messages, posts, docs).

1. Read `PROFILE.md`.
2. Match an evidenced register for the same audience, medium, and purpose. If
   none exists, transfer only the voice invariants, follow the genre's normal
   conventions, and avoid importing context-specific habits.
3. Write or review. Match fingerprints lightly; repeated signature markers read
   as parody.
4. Return the requested prose first. Explain register choice only when ambiguity
   materially changes the result or the user asks. Put any evidence-gap note
   after the draft.
5. When reviewing, separate four kinds of finding:
   - **Voice mismatch** — conflicts with evidenced invariants or the register.
   - **Genre mismatch** — wrong for the audience or medium, even if voice-like.
   - **Writing problem** — unclear structure, unsupported claims, or factual
     weakness that is not about voice.
   - **Caricature** — overuses a real fingerprint or invents personality.
6. Quote only the highest-impact passages, give concrete rewrites, and briefly
   note what already sounds right.

If no profile exists, offer update mode first. If the profile lacks the requested
register, produce a cautious draft from invariants rather than inventing one.

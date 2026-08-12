---
name: arena
description: "Spawn N parallel candidates at the same task, pick a base, graft the strongest parts of the losers into it. Use for /arena, 'arena this', 'throw it in the arena', or when one attempt at a non-trivial artifact would lock in the wrong shape."
---

# Arena

Fan out N parallel attempts at the same task. Read every candidate end to end. Pick the strongest as the base. Graft the best ideas from the others into it. Verify the synthesized result.

## Start

Open a todolist with one entry per phase before launching anything. The arena runs autonomously and the list keeps phases from silently disappearing.

1. Frame
2. Fan out
3. Cross-judge
4. Pick
5. Graft
6. Verify

## Phase A: Frame

The N candidates will receive the same prompt, so the prompt is the contract. Get it right before spawning anything.

1. **State the artifact** each candidate is producing.
2. **Derive the rubric.** State what success looks like for *this* task, then turn it into 3–6 concrete gradeable criteria. Concrete: `Adds a --dry-run flag that skips writes`. Vague: `code is correct`. The rubric is the picker's tool in Phase D; candidates only see the task.
3. **Pick the runners.** Default to 3–4 candidates across different models when available (e.g. one each on Claude Sonnet, Gemini, GPT). Spawn more when the arena covers multiple design directions. Same model N times when the work is generation-bound rather than judgment-sensitive.
4. **Assign output paths.** Each candidate writes to its own location. Use `/tmp/arena-<slug>/candidate-<n>/` or separate directories under the working tree. N candidates writing to the same path is shared mutable state and will produce corrupt results.

## Phase B: Fan out

Spawn all N candidates in parallel using the `subagent` tool's parallel mode:

```
subagent({
  tasks: [
    { agent: "worker", task: "<full task prompt with output path>", cwd: "<candidate dir>" },
    { agent: "worker", task: "<full task prompt with output path>", cwd: "<candidate dir>" },
    ...
  ]
})
```

If the `subagent` tool is not available, spawn candidates by running `pi -p --no-session` subprocesses via bash, one per candidate, backgrounded and waited on.

Each candidate receives:
- The full task description
- Its own output path
- Instructions to produce both the artifact and a short **rationale**

The rationale is mandatory. Without it, the parent cannot tell whether a candidate's structure is principled or accidental, which makes Phase E grafting unreliable. Each rationale names the alternatives the candidate considered and what it rejected.

If a candidate fails to produce output, proceed with N−1 and note the dropout in the synthesis record.

## Phase C: Cross-judge

After all candidates complete, spawn one read-only judge on a different model from the candidates. The judge sees:
- The rubric (from Phase A)
- Each candidate's output (by path label, not by model name — blind judging)

The judge scores each criterion and recommends a base with rationale.

Use the `subagent` tool in single mode with a read-only agent (tools: `read, grep, find, ls`) and a model different from the runners. If no suitable alternate model is available, the parent performs the judgment directly and notes the lack of independence.

## Phase D: Pick a base

Read every candidate end to end before picking. Skimming N candidates surfaces only the candidate whose surface looks most familiar.

Score each candidate against the rubric criterion by criterion, not on holistic feel. Compare against the cross-judge. Agreement on the base confirms the pick. Disagreement means one of you is biased or the rubric was ambiguous — read both rationales before deciding.

Pick the base on which candidate a future maintainer can extend most easily without breaking invariants. Prefer the cleaner boundary or smaller surface area when two feel tied.

Record the pick and the reason in a short synthesis note alongside the base artifact, including the cross-judge's verdict.

## Phase E: Graft

Walk each losing candidate once more and identify what is worth porting into the base. The signal is usually one or two things per candidate, not most of it.

Fold each graft in by hand. Don't paste mechanically. The result has to remain coherent under one mental model.

Record what was grafted, from which candidate, and what was rejected and why. The rejection notes are the highest-signal part of the record. Future readers learn from what you considered and dropped, not just what you kept.

When N candidates converge on the same shape, that is a strong agreement signal. Note the convergence in the record and ship the consensus shape. No graft is needed. When N candidates wildly diverge, Phase A was under-specified. Reframe and re-run rather than averaging the divergence.

## Phase F: Verify

The synthesized artifact has to hold up under the same scrutiny as any other output. The arena does not earn you a pass.

Run the appropriate verification: tests, type checks, linting, manual inspection, or whatever the artifact requires. If verification surfaces a problem the arena did not catch, either Phase A was wrong (re-frame and re-run) or one candidate caught it and you missed the graft (go back to Phase E). Don't paper over.

## Outputs

One synthesized artifact. One short synthesis note alongside, naming:
- The base candidate and why it was chosen
- The grafts (with source candidate) and what they added
- The rejections (with source candidate) and why they were dropped
- Dropouts, if any
- The cross-judge's verdict and any disagreements
- The verification result

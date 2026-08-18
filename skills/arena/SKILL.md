---
name: arena
description: "Spawn N parallel candidates at the same task, pick a base, graft the strongest parts of the losers into it. Use for /arena, 'arena this', 'throw it in the arena', or when one attempt at a non-trivial artifact would lock in the wrong shape."
---

# Arena

Fan out N parallel attempts at the same task. Read every candidate end to end. Pick the strongest as the base. Graft the best ideas from the others into it. Verify the synthesized result.

## Track the phases

Keep one visible checklist in working notes or status updates before launching candidates. The `parallel_agents` tool supplies a live status pane during fan-out and cross-judging; the checklist tracks the parent-only pick, graft, and verify phases.

1. Frame
2. Fan out
3. Cross-judge
4. Pick
5. Graft
6. Verify

## Configuration

Read `$PI_CODING_AGENT_DIR/kstack.json` (default `~/.pi/agent/kstack.json`) for model assignments. The `arena` section:

```json
{
  "arena": {
    "runners": [
      { "label": "terra", "model": "openai/gpt-5.6-terra", "thinking": "max" },
      { "label": "gemini", "model": "google-vertex/gemini-3.7-flash", "thinking": "high" },
      { "label": "kimi", "model": "openrouter/moonshotai/kimi-k3", "thinking": "high" }
    ],
    "crossJudge": { "model": "openai/gpt-5.6-sol", "thinking": "medium" },
    "maxConcurrency": 4
  }
}
```

- `runners` — models to use as candidates. Each gets `label` and `model` (in `provider/model` form). Optional `thinking` level.
- `crossJudge` — model for the independent cross-judge in Phase C. Prefer a different model family from the runners.
- `maxConcurrency` — max parallel candidates (default 4).

When `kstack.json` is absent or has no `arena` section, ask the user which models to use or default to 3 candidates on distinct available models.

## Phase A: Frame

The N candidates will receive the same prompt, so the prompt is the contract. Get it right before spawning anything.

1. **State the artifact** each candidate is producing.
2. **Derive the rubric.** State what success looks like for *this* task, then turn it into 3–6 concrete gradeable criteria. Concrete: `Adds a --dry-run flag that skips writes`. Vague: `code is correct`. The rubric is the picker’s tool in Phase D; candidates only see the task.
3. **Pick the runners.** Use `runners` from `kstack.json` when present. Otherwise default to 3–4 candidates across different available models. Spawn more when the arena covers multiple design directions. Same model N times when the work is generation-bound rather than judgment-sensitive.
4. **Assign output paths.** Each candidate writes to its own pre-created worktree or directory. Use the `git-worktrees` skill when the repository uses Git; use the repository's configured workspace mechanism for other VCS backends. N candidates writing to the same path is shared mutable state and will produce corrupt results.

## Phase B: Fan out

Spawn all N candidates in one `parallel_agents` tool call with `kind: "arena"` and the configured `maxConcurrency`. The extension shows the same live status pane used by panel review: queued/running/completed state, model, elapsed time, current tool, and output preview. Do not replace it with background `pi` commands or a silent shell `wait`.

Use `access: "read-only"` when candidates return proposals in their final reports. Use `access: "workspace"` only when a candidate must create an artifact, and set `cwd` to a distinct pre-created candidate worktree or directory for every writable task; the tool rejects shared writable directories. Children run without extensions, skills, prompt templates, or context files. Put self-contained instructions in each prompt because repository instruction files are not loaded.

Each candidate receives:
- The full task description
- Its own output path
- Instructions to produce both the artifact and a short **rationale**

The rationale is mandatory. Without it, the parent cannot tell whether a candidate's structure is principled or accidental, which makes Phase E grafting unreliable. Each rationale names the alternatives the candidate considered and what it rejected.

If a candidate fails to produce output, proceed with N−1 and note the dropout in the synthesis record.

## Phase C: Cross-judge

After all candidates complete, run the judge through a second `parallel_agents` call with one `kind: "arena"` task on a different model from the candidates. The judge sees:
- The rubric (from Phase A)
- Each candidate's output (by candidate label, not by model name — blind judging)

The judge scores each criterion and recommends a base with rationale.

Use the `crossJudge` model from `kstack.json`. If unconfigured, pick a model from a different family than the runners. If no suitable alternate model is available, the parent performs the judgment directly and notes the lack of independence.

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

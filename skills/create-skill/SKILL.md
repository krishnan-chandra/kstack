---
name: create-skill
description: Create new skills for Pi from scratch, turn existing workflows into skills, improve or debug existing skills, and measure skill performance. Use whenever the user wants to build a skill, write a SKILL.md, capture a repeated workflow as a skill, add scripts or references to a skill, fix a skill that is not triggering, write skill eval prompts or test cases, or benchmark a skill against doing the task without it. Also use when the user says "make me a skill", "turn this into a skill", "rewrite this skill", "why is my skill not being used", or asks to test, evaluate, or optimize a skill, even if they never say the word "skill".
license: MIT
compatibility: Pi CLI with headless mode (pi -p --mode json) for eval runs; python3 for the helper scripts under scripts/; eval runs make real model calls and cost tokens.
---

# Create a skill for Pi

A skill is a directory with a `SKILL.md` (frontmatter + instructions) plus optional `scripts/`, `references/`, and `assets/`. Pi loads only the name and description into context; the body and resources load on demand when the model decides to consult the skill.

The process, in one loop:

- Decide what the skill should do and roughly how
- Draft the skill
- Write a few realistic test prompts
- Run each prompt headlessly, twice: with the skill and without it (baseline)
- Review the outputs with the user, qualitatively and quantitatively
- Rewrite the skill, rerun, repeat until the user is happy
- Optionally optimize the description so the skill triggers reliably

Figure out where the user is in this loop and help them progress. Maybe they already have a draft — then skip straight to testing. Maybe they say "I don't need evals, just vibe with me" — then do that. Be flexible.

## Communicating with the user

Users range from "plumber who just opened a terminal" to professional developers. Match their level. "Evaluation" and "benchmark" are borderline but fine; do not use "JSON", "assertion", or "regex" without a quick explanation unless the user clearly knows them. Briefly define terms when in doubt.

## Before writing anything

1. Read Pi's installed `docs/skills.md` **completely** (resolve from the installed package, in this environment `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/skills.md`). Do not guess the skill format or frontmatter rules.
2. Look at 2-3 existing skills in this repository (`skills/create-pi-extension/` and anything else present) for house style.
3. Search archived session history for prior skill work so you inherit decisions instead of repeating them.
4. If the user is capturing a workflow that already happened in this conversation, extract the steps, tools used, corrections, and input/output formats from the conversation before asking questions.

## Creating a skill

### Capture intent

1. What should this skill enable Pi to do?
2. When should it trigger — which user phrases or contexts?
3. What is the expected output format?
4. Do we need test cases? Skills with objectively verifiable outputs (file transforms, data extraction, code generation, fixed workflows) benefit from them. Subjective skills (writing style, art) usually do not. Suggest the right default; let the user decide.

### Interview and research

Proactively ask about edge cases, input/output formats, example files, success criteria, dependencies, and what "done" looks like. Research before drafting: Pi docs, MCP servers, similar skills on the [Agent Skills](https://agentskills.io/specification) ecosystem. Come prepared to reduce the burden on the user.

### Write the SKILL.md

- **name** — max 64 chars, lowercase letters/numbers/hyphens only, no leading/trailing/consecutive hyphens.
- **description** — max 1024 chars. This is the primary trigger mechanism. Include what the skill does **and** the specific contexts that should trigger it. Pi models tend to *undertrigger* skills, so be a little pushy: instead of "Extracts tables from PDFs", write "Extracts tables and text from PDF documents, fills PDF forms, and merges PDFs. Use whenever the user mentions PDFs, forms, or document extraction, even if they don't ask for a 'skill'."
- **compatibility** — optional; environment requirements (tools, runtimes, network).
- **license**, **metadata**, **allowed-tools**, **disable-model-invocation** — optional; see `docs/skills.md`.

**Progressive disclosure:** keep SKILL.md under 500 lines. If it grows past that, push detail into `references/` with clear pointers on when to read each file, and include a table of contents in reference files over ~300 lines. Organize multi-domain skills by variant (`references/aws.md`, `references/gcp.md`...). Bundle deterministic work as `scripts/` so the model does not reinvent it every invocation. Use `assets/` for templates, icons, fonts used in output.

**Writing patterns:**
- Imperative instructions; explain the *why* instead of heavy-handed MUSTs. If you find yourself writing ALL CAPS ALWAYS/NEVER, reframe as reasoning — LLMs follow "because X matters" better than "must do X".
- Define output formats as exact templates; include Input→Output examples.
- Make the skill general, not a transcript of the test cases you wrote.

**Principle of Lack of Surprise:** no malware, no exploit code, nothing that compromises system security. Do not create misleading skills or skills for unauthorized access, data exfiltration, or other malicious ends.

### Test cases

Write 2-3 realistic prompts — the kind of thing a real user would actually type, with concrete detail (file names, column names, personal context), not "Format this data". Share them with the user and ask if they look right before running. Save to `evals/evals.json` in the skill directory — prompts only at first; assertions come later (see [references/schemas.md](references/schemas.md)).

## Running test cases

Put results in `<repo>/.workspace/<skill-name>/iteration-N/` (the `.workspace/` root is gitignored). Within the iteration: one directory per test case, named by what it tests (not `eval-0`), each containing `with_skill/` and `without_skill/` runs. Create directories as you go.

Do NOT stop partway through this sequence. Do NOT use `/skill-test` or any other testing skill — use the scripts in this skill.

### Step 1: Launch all runs in the same turn, in parallel

Pi skills run inside the main agent, which has no subagent tool, so test runs are isolated **headless `pi -p` subprocesses** — same isolation, same evidence, and we control exactly what each run can see. Launch every eval × configuration at once as background jobs so they finish around the same time.

For each test case, use `scripts/run_eval.py` twice:

```bash
# with-skill run: skill under test is the only skill available
python3 skills/create-skill/scripts/run_eval.py \
  --work-dir .workspace/<skill>/iteration-1/eval-<name>/with_skill/work \
  --run-dir  .workspace/<skill>/iteration-1/eval-<name>/with_skill \
  --skill    skills/<skill> \
  --prompt-file <skill>/evals/<prompt>.txt \
  --files    <skill>/evals/files \        # only if the eval has input files

# baseline run: same prompt, no skill at all
python3 skills/create-skill/scripts/run_eval.py \
  --work-dir .workspace/<skill>/iteration-1/eval-<name>/without_skill/work \
  --run-dir  .workspace/<skill>/iteration-1/eval-<name>/without_skill \
  --prompt-file <skill>/evals/<prompt>.txt \
  --files    <skill>/evals/files
```

Run all of these with `&` and `wait` in one bash call. Keep the eval prompt in a file (not a shell argument) to avoid quoting bugs. `run_eval.py` handles: isolated work dir with input files copied in, `--no-skills --skill <path>` (with-skill) vs `--no-skills` (baseline), `--no-extensions --no-context-files`, `--session-dir` for the transcript, JSON output mode. It saves `transcript.jsonl`, `outputs/result.txt`, `outputs/tool_calls.json`, `timing.json`, and records whether the model actually read the skill's SKILL.md.

- **Improving an existing skill?** Snapshot it first: `cp -r skills/<skill> .workspace/<skill>/skill-snapshot/`, then point the baseline run at the snapshot the same way you would the new version.
- Write `eval_metadata.json` in each eval directory (prompt, eval_id, eval_name, assertions empty for now — schema in [references/schemas.md](references/schemas.md)).
- `triggered: false` on a with-skill run is not automatically a failure: a model may follow a self-contained description without ever reading SKILL.md. Check the output first. It *is* a triggering problem when the run failed its expectations **and** never read the skill. To separate capability from triggering, rerun with `--force-skill` (appends "consult the skill at <path>" to the prompt) and treat the two runs differently.

### Step 2: While runs are in progress, draft assertions

Do not wait idle. Draft quantitative assertions per test case and explain them to the user. Good assertions are objectively verifiable with descriptive names. Subjective outputs are better judged by the human — do not force assertions onto taste.

Assertions that can be checked by script (file exists, file contains, line count, regex match) get a `check` block — see [references/schemas.md](references/schemas.md). Update `eval_metadata.json` and `evals/evals.json` once drafted.

### Step 3: Timing data

`run_eval.py` captures `total_tokens` (from the session stream) and wall-clock duration into `timing.json` automatically — nothing for you to catch.

### Step 4: Grade, aggregate, analyze, review

1. **Grade each run.** For programmatic assertions run `scripts/grade.py <run-dir> --metadata <eval_metadata.json>`; it writes `grading.json` with `text`/`passed`/`evidence` for every machine-checkable assertion. Judge the rest yourself by reading the outputs and transcript, and append them to `grading.json` using the same three fields, then recompute the summary. The viewer depends on exactly those field names.
2. **Aggregate** into a benchmark:

   ```bash
   python3 skills/create-skill/scripts/aggregate_benchmark.py \
     .workspace/<skill>/iteration-1 --skill-name <name>
   ```

   This writes `benchmark.json` and `benchmark.md` with pass rate, time, and tokens per configuration (with_skill before baseline), mean ± stddev, and the delta.
3. **Analyst pass.** Read the data for what aggregates hide: assertions that pass with or without the skill (non-discriminating), high-variance evals (possibly flaky), and time/token tradeoffs. Add these observations to `benchmark.json`'s `notes` (the viewer renders them on the Benchmark tab) and to `benchmark.md`.
4. **Put it in front of the user.** Show the outputs inline in the conversation (prompt → with-skill result → baseline result) and summarize the benchmark. Offer the static review page so they can click through everything in a browser:

   ```bash
   python3 skills/create-skill/scripts/generate_review.py \
     .workspace/<skill>/iteration-1 \
     --skill-name <name> \
     --benchmark .workspace/<skill>/iteration-1/benchmark.json \
     --out /tmp/review-<skill>-iteration-1.html
   open /tmp/review-<skill>-iteration-1.html
   ```

   For iteration 2+, add `--previous-workspace .workspace/<skill>/iteration-<N-1>`.

   GENERATE THE REVIEW *BEFORE* evaluating outputs yourself — get them in front of the human ASAP. The page has an Outputs tab (each test case with prompt, outputs rendered inline, formal grades, feedback box) and a Benchmark tab (stats + analyst notes). Feedback is downloaded as `feedback.json` when the user clicks "Export feedback"; after download, copy it into the workspace for the next iteration.

### Step 5: Read the feedback

When the user says they are done, read the feedback (inline comments, or `feedback.json` if they used the page). Empty feedback means it was fine. Focus improvements where the user had specific complaints.

## Improving the skill

1. **Generalize from the feedback.** You are iterating on a few examples that the user knows cold. If your fix only works for those examples, the skill is useless. Prefer broader patterns over fiddly, overfit rules.
2. **Keep the prompt lean.** Read the transcripts, not just final outputs. If the skill makes the model waste turns on unproductive work, cut the parts causing it.
3. **Explain the why.** Today's models are smart; give them understanding, not a rulebook. ALWAYS/NEVER in caps is a yellow flag — reframe as reasoning.
4. **Bundle repeated work.** If every test run independently writes a `build_chart.py`, that is a strong signal to ship it once in `scripts/` and tell the skill to use it.

Then: apply improvements, rerun all test cases into `iteration-<N+1>` (with the same baseline), relaunch the review with `--previous-workspace`, wait for feedback, improve again. Keep going until the user is happy, all feedback is empty, or you are no longer making progress.

## Description optimization

The `description` frontmatter is the trigger mechanism: Pi puts name + description in the system prompt, and the model decides whether to consult the skill. Skills only get consulted for tasks the model cannot trivially handle alone, so eval queries must be substantive — "read this PDF" will not trigger anything regardless of description quality.

1. **Generate ~20 trigger queries** — 8-10 should-trigger (varied phrasings, casual and formal, some that never say "skill") and 8-10 should-not-trigger **near-misses** (share keywords with the skill but need something else; obviously irrelevant queries test nothing). Realistic and concrete: file paths, job context, column names, typos, backstory.
2. **Review with the user inline.** Show the queries and let them edit, toggle, add, remove. Save to `.workspace/<skill>/triggers.json` as `[{"query": "...", "should_trigger": true}, ...]`.
3. **Measure the current description:**

   ```bash
   python3 skills/create-skill/scripts/run_trigger_eval.py \
     --eval-set .workspace/<skill>/triggers.json \
     --skill-path skills/<skill> \
     --out-dir .workspace/<skill>/trigger-eval
   ```

   Each query is a headless `pi -p` run with the skill as the only available skill; "triggered" means the model read the skill's SKILL.md (the proxy for "consulted the skill" — descriptions that fully capture a trivial skill may not need a read, which the results will show). The script reports per-query results, false positives/negatives, and overall score.
4. **Iterate (agent-driven, max 5 iterations).** Split 60% train / 40% held-out. Each iteration: propose a description revision aimed at what failed, rerun with `--description "..."` (the script builds a temp skill dir with that frontmatter — no need to mutate the real file, and candidates can run in parallel), and compare scores. Pick the best by **held-out** score, not train, to avoid overfitting. Tell the user this takes a while and check in with progress and scores.
5. **Apply the winner** to the skill's frontmatter; show before/after and the scores. Mind the 1024-char limit.

This is the last step — only after the user agrees the skill itself is in good shape.

## Install and present

Pi has no `.skill` packaging step. When the skill is done, point the user at `skills/<skill>/` and offer to make it available:

- This repository is installed as a local Pi package, so `skills/` directories are auto-discovered — just `/reload` (or restart Pi), then check `pi list` or `/skill:<name>`.
- Or symlink into the global skills dir: `ln -s "$PWD/skills/<skill>" ~/.pi/agent/skills/<skill>`.
- Or test in isolation: `pi -p --no-skills --skill skills/<skill> "task"`.

## Reference files

- `references/schemas.md` — exact JSON structures for `evals.json`, `eval_metadata.json`, `grading.json`, `timing.json`, `benchmark.json`, and trigger eval sets.
- `scripts/run_eval.py` — one headless with-skill/baseline run.
- `scripts/grade.py` — programmatic assertion grading.
- `scripts/aggregate_benchmark.py` — per-iteration benchmark summary.
- `scripts/generate_review.py` — static HTML review page.
- `scripts/run_trigger_eval.py` — description trigger measurement.

The core loop, one more time: figure out what the skill is about → draft or edit it → run headless with-skill and baseline on test prompts → review outputs with the user (benchmark + review page) → improve → repeat → optimize the description → install.

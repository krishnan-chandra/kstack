---
name: technical-writing
description: Write or review clear technical prose using Diátaxis structure, Google developer style, STE instruction rules, and Global English clarity. Use whenever the user asks to add, preserve, update, rewrite, or review code comments, docstrings, docs, RFCs, READMEs, guides, reference pages, release notes, PR descriptions, or commit messages, or to explain, document, polish, or clarify technical writing.
license: MIT
---

# Technical writing

Write so that a tired engineer understands it on the first read. Apply four layers in order: pick the right document type, address the reader directly, limit what each sentence carries, and remove ambiguity.

Three rules sit above the layers:

- Cut every word that does no work. "In order to" becomes "to." "It is important to note that" usually disappears.
- Prefer the short everyday word. A longer word needs to earn its precision.
- Rules serve the reader. If literal compliance makes a sentence worse, rewrite it another way or leave an intentional exception alone.

Use the codebase as the word list. Name the real symbol, file, flag, command, and behavior. Do not replace a precise project term with a vague synonym.

Before publishing prose, apply the `unslop` skill. It removes generic AI patterns and protects the document's intended voice.

## Vary the rhythm

Clear writing does not need to sound mechanical.

- Mix sentence lengths deliberately. A short sentence can land a point. A longer sentence can keep a fact with its condition or consequence.
- One thought per sentence does not mean every sentence has the same length. Split a sentence with two thoughts; keep a longer sentence that carries one.
- In explanations, make a judgment about trade-offs instead of only listing pros and cons. Keep reference material dry.
- Prefer concrete detail to sterile generalities. Say that a column rename fails the build, not that schema changes can cause issues.

## Pick the mode first

Use one primary Diátaxis mode per document. Ask whether the content supports action or understanding, then whether it serves learning or work.

| Purpose | Learning | Work |
| --- | --- | --- |
| Action | Tutorial | How-to guide |
| Understanding | Explanation | Reference |

Split and link material when modes meet. A tutorial should not contain a reference table, and a reference page should not turn into a guided lesson.

### Tutorial: learning by doing

Teach a learner to build something. Open with what they will make. Give each step a visible result early and often, including the expected output, UI change, or log line. Keep explanation to the clause needed to unblock the step and link to deeper material. Write as "we" when that makes the shared exercise clearer.

### How-to guide: completing a task

Solve a reader's practical problem. Assume competence and keep only the actions needed to reach the goal. Name the guide for the task, not the machine operation. Allow real forks: "If you need X, do Y." Put background and completeness elsewhere.

### Reference: looking up facts

Describe the thing as it is. State options, limits, defaults, and errors accurately and without persuasion or instruction. Mirror the structure of the code or interface so readers can navigate both the same way. Generate reference from source when practical.

### Explanation: understanding why

Address one bounded topic that can be read away from the product. Anchor the piece on a real why question, then explain the design decisions, history, constraints, and alternatives. Opinion is appropriate here when it helps the reader assess a trade-off.

## Write sentences to the reader

- Address the reader as "you" and use present tense. Use "will" only for events that genuinely happen later.
- Name the actor and action: "the compiler checks" instead of "is checked." Keep passive voice only when the actor does not matter.
- Write instructions as commands: "Click Submit." Put the condition first: "To delete the document, click Delete."
- Put the common case first and exceptions after it.
- Sound like a knowledgeable colleague. Avoid buzzwords, figurative language, and "please," "simply," "easy," or "quickly" in procedures.
- Do not pre-announce future content. Avoid starting consecutive sentences with the same phrase.
- Use link text that names the destination or describes it. Never write "click here."
- Make headings carry the point. Use sentence case, one h1 per page, no skipped levels, verb phrases for tasks, and noun phrases for concepts.
- Use numbered lists for sequences and bullets for non-sequences. Introduce each list with a complete sentence and keep its items parallel.
- Put code in code font and UI labels in bold. Use serial commas. Say when a list is partial instead of writing "etc."

## Make each statement easy to parse

Apply the transferable parts of Simplified Technical English:

- Keep one instruction per sentence and one thought per sentence elsewhere.
- Split instructions longer than roughly 20 words and other sentences longer than roughly 25 when doing so makes them clearer.
- Put the warning or condition before the step it guards.
- Keep articles when they prevent ambiguity: "Remove the backup file," not "Remove backup file."
- Give each important word one meaning and use it consistently. If "check" means inspect, do not also use it to mean restrain.
- Use direct commands for procedures rather than narration or passive voice.
- Avoid unnecessary "-ing" forms. They often hide the actor or relationship.

## Remove ambiguous readings

Apply Global English principles where they improve clarity:

- Put "only" and "not" beside the words they modify.
- Break long noun strings into clauses: "the script that checks the proto import budget" is clearer than "the proto import budget check script."
- Make every "it," "they," and "this" point to one obvious noun. Repeat the noun when needed. Do not let "this" or "which" stand for a whole preceding clause.
- Keep verbs in parallel clauses. Do not make the reader infer a missing one.
- Keep small structural words such as "that" when they prevent a misread.
- Repeat articles or use "both ... and," "either ... or," and "if ... then" when they reveal grouping.
- Prefer periods to semicolons and em dashes. Avoid slashes such as "a/b" or "and/or."
- Give each thing one name throughout the document. Do not churn unchanged prose merely to vary wording.
- Skip idioms, unexplained abbreviations, and metaphors when plain language works better for readers, translators, and agents.

## Repo-specific accuracy

- Product UI strings need the product's copy guidelines, not this documentation standard.
- Use real paths and symbols. Verify every count, tree claim, and command at the commit that lands it; include a regeneration command when a reader needs one.
- Follow the repository's Markdown and code-snippet conventions. Do not change working examples only to satisfy a prose preference.
- PR descriptions and commit messages benefit from every layer except the document-mode taxonomy. State the change, why it exists, evidence, and risks without ceremony.

## Worked example

Before:

> Configuration of the proto import ratchet budget script parameters is performed via budget.json. Note that it's important to remember that running with --write, which updates the committed budget to reflect the current count, should only be done when lowering it. If exceeded, CI fails.

After:

> `budget.mjs` reads the committed budget from `budget.json` and counts the files that import protos. If the count exceeds the budget, CI fails. Run `budget.mjs --write` only to lower the budget.

The revision names the actor, uses the real file name, gives the failure condition a subject, and puts "only" beside the action it limits.

## Review checklist

1. Does each file have one primary Diátaxis mode, with links where modes meet?
2. Does every instruction use a command with its condition before it?
3. Does any sentence carry two instructions or thoughts that should be split?
4. Can any word be cut without losing meaning?
5. Is "only" next to its target? Does every pronoun have one clear noun? Does every clause keep its verb?
6. Does each thing have one name throughout the document?
7. Would a developer say these words aloud? Replace invented metaphors and fancy synonyms with the plain word or real symbol name.
8. Are paths, symbols, counts, and commands true at this commit?

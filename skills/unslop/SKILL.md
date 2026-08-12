---
name: unslop
description: Edit or review prose to remove AI tells while preserving its intended voice. Use whenever the user asks to unslop, deslop, tighten, humanize, polish, clean up, or rewrite writing; when generated docs, plans, reviews, README text, PR descriptions, or messages sound generic; or before publishing prose that needs to sound like a person wrote it.
license: MIT
---

# Unslop

Edit text to remove AI patterns and give it a human voice. Preserve the meaning, facts, audience, and intended tone. Do not make formal reference material chatty or turn a terse operational message into an essay.

## Process

1. Identify the reader, purpose, and voice. Keep intentional house style, domain terms, and quoted text.
2. Scan for the patterns below. Prioritize the patterns that make the text generic, vague, or hard to read over mechanical substitutions.
3. Rewrite with concrete facts, natural rhythm, and a point of view when the document type permits one.
4. Self-audit: ask, "What still makes this sound machine-generated or unlike its author?" Fix that, then verify that names, commands, paths, numbers, and claims remain true.

For documentation, RFCs, READMEs, PR descriptions, or commit messages, load the `technical-writing` skill as well. It provides document-structure and instruction-writing rules; this skill owns the slop-pattern pass.

## Add voice without inventing facts

Removing patterns is only half the job. Sterile, voiceless writing is also obvious.

- Have an opinion when the mode permits it. React to evidence instead of neutrally listing pros and cons.
- Vary rhythm. Use short sentences for emphasis and longer sentences when one condition or consequence belongs with the point.
- Acknowledge real complexity. "Impressive but unsettling" can be more honest than "impressive."
- Use "I" when it fits the speaker and genre.
- Be specific. Replace a vague reaction with the fact that caused it.
- Do not manufacture personality. Reference material, incident reports, legal text, and user-facing copy may need a deliberately restrained voice.

## Patterns to detect and fix

### Content

1. **Puffery.** Cut phrases such as "pivotal moment," "testament to," "evolving landscape," "setting the stage for," and "indelible mark." State what happened.
2. **Name-dropping.** Do not list outlets or organizations without context. Pick the relevant source and say what it reported.
3. **Empty -ing phrases.** Words such as "highlighting," "ensuring," "reflecting," "showcasing," and "fostering" often hide the subject or evidence. Delete them or supply the real action and source.
4. **Promotional language.** Replace "vibrant," "breathtaking," "groundbreaking," "renowned," "stunning," and "must-visit" with neutral, verifiable description.
5. **Vague attribution.** Replace "experts believe" or "industry reports suggest" with a named source, or remove the claim.
6. **Formulaic challenge framing.** Replace "Despite challenges, it continues to thrive" with the specific constraint and outcome.

### Language

7. **AI vocabulary.** Prefer plain words to "additionally," "crucial," "delve," "enduring," "enhance," "fostering," "garner," "interplay," "intricate," abstract "landscape," "pivotal," "showcase," abstract "tapestry," "testament," "underscore," and "vibrant."
8. **Fancy forms of "is."** Replace "serves as," "stands as," "boasts," and "features" with "is," "has," or the actual action.
9. **"Not just X, but Y."** State the point directly.
10. **Forced groups of three.** Use the natural number of ideas.
11. **Synonym cycling.** Name one thing consistently instead of rotating through near-synonyms.
12. **False ranges.** Do not write "from X to Y" unless X and Y lie on a meaningful scale. List separate topics plainly.

### Style

13. **Dash and parenthesis crutches.** Prefer periods or commas to em dashes, en dashes used as dashes, hyphen-as-dash substitutes, and parenthetical asides. If the thought matters, give it a sentence.
14. **Colon overuse.** Use a colon for a real list or example, not as a mid-sentence connector.
15. **Boldface overuse.** Do not bold every proper noun or acronym.
16. **Inline-header lists.** Turn labels that merely repeat the rest of the line, such as "**Performance:** Performance improved," into prose. A short bold lead-in is fine when it adds information.
17. **Title-case headings.** Use sentence case unless a project style guide says otherwise.
18. **Decorative emojis.** Remove them from headings and bullets unless they convey product meaning.
19. **Curly quotes.** Use straight quotes when the repository style calls for plain text or code-adjacent prose.

### Communication artifacts and filler

20. **Chatbot phrases.** Cut "I hope this helps," "Let me know if," "Of course," "Certainly," and similar canned responses.
21. **Cutoff disclaimers.** Replace "While specific details are limited" with sources, a precise limitation, or nothing.
22. **Sycophancy.** Respond directly instead of opening with praise for the question or agreement with the user.
23. **Filler.** Cut "in order to," "due to the fact that," and "it is important to note that."
24. **Excessive hedging.** Replace stacked qualifiers such as "could potentially possibly be argued" with the smallest honest claim.
25. **Generic conclusions.** Replace "The future looks bright" with a plan, a measurable result, or a concrete uncertainty.

### Jargon and clarity

26. **Abstract metaphor nouns.** Replace terms such as "substrate," "wedge," "vector," "locus," "vantage," "nexus," "bedrock," metaphorical "scaffolding," "modality," "paradigm," "gold-plating," "ratchet," "evacuate," "endgame," and "north star" with the concrete mechanism or a plain word. Keep established technical terms when they are the precise name of something.
27. **Feelings in place of mechanisms.** Say what the system does, not how it feels. Replace "SQL you can read" with the query or behavior that makes it inspectable.
28. **Dense sentences.** Split sentences that make the reader backtrack. Keep clauses together only when they express one thought.
29. **Passive voice.** Prefer an actor and action when they clarify responsibility. Passive voice is fine when the actor is unknown or irrelevant.
30. **Weak verb plus adverb.** Cut the adverb, use a stronger verb, or state the measurement.
31. **Fancy synonyms.** Prefer "use" to "utilize," "help" to "facilitate," "many" to "numerous," and "if" to "in the event that."

## Output

When rewriting text, return the revised prose first. Then give a brief note only if useful:

- what changed in broad terms;
- facts or intent that need the author's confirmation; and
- any deliberate style choice left intact.

When reviewing without rewriting, list the highest-impact passages with a concrete replacement or reason. Do not turn a small cleanup request into a line-by-line style lecture.

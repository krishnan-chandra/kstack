import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCritique } from "./critique.ts";

function parse(raw: string) {
	const result = parseCritique(raw);
	assert.ok(result.ok, result.ok ? "" : result.error);
	return result.critique;
}

describe("parseCritique", () => {
	it("rejects unparseable nonempty blocking content instead of silently approving", () => {
		for (const blocking of [
			"- **[B-1]** Deletes user data.",
			"This is unsafe.",
			"```\n- [B-1] Hidden blocker\n```",
			"## Other heading\nunsafe",
		]) {
			const parsed = parseCritique(`Verdict: approve\n\n## Blocking\n${blocking}\n\n## Suggestions\nNone.\n`);
			assert.equal(parsed.ok, false, blocking);
		}
	});
	it("parses verdict, blocking, suggestion, and resolved sections", () => {
		const critique = parse(`Verdict: revise

## Blocking
- [B-1] Missing test evidence in src/a.ts.

## Suggestions
- [S-1] Name the helper.

## Resolved from previous round
- B-2: Added the rollback acceptance criterion.
`);
		assert.equal(critique.verdict, "revise");
		assert.deepEqual(critique.blocking, [{ id: "B-1", text: "Missing test evidence in src/a.ts." }]);
		assert.deepEqual(critique.suggestions, [{ id: "S-1", text: "Name the helper." }]);
		assert.deepEqual(critique.resolved, [{ id: "B-2", summary: "Added the rollback acceptance criterion." }]);
	});

	it("accepts approve with empty sections", () => {
		const critique = parse(`Verdict: approve

## Blocking
None.

## Suggestions
None.
`);
		assert.equal(critique.verdict, "approve");
		assert.deepEqual(critique.blocking, []);
	});

	it("downgrades approve when a blocking finding remains", () => {
		const critique = parse(`Verdict: approve

## Blocking
- [B-1] This remains open.

## Suggestions
None.
`);
		assert.equal(critique.verdict, "revise");
	});

	it("ignores verdicts and findings inside fenced examples", () => {
		const critique = parse(`Verdict: approve

\`\`\`markdown
Verdict: revise
## Blocking
- [B-99] Example only.
\`\`\`

## Blocking
None.

## Suggestions
None.
`);
		assert.equal(critique.verdict, "approve");
		assert.deepEqual(critique.blocking, []);
	});

	it("rejects malformed and incomplete critiques", () => {
		assert.equal(parseCritique("## Blocking\nNone.\n## Suggestions\nNone.").ok, false);
		assert.equal(parseCritique("Verdict: maybe\n## Blocking\nNone.\n## Suggestions\nNone.").ok, false);
		assert.equal(parseCritique("Verdict: approve\n## Blocking\nNone.").ok, false);
		assert.equal(
			parseCritique("Verdict: revise\n## Blocking\n- [B-1] one\n- [B-1] two\n## Suggestions\nNone.\n").ok,
			false,
		);
	});
});

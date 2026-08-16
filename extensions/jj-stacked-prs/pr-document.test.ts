import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePrMarkdown, renderPrDocument } from "./pr-document.ts";

describe("pr-document", () => {
	it("round-trips a valid write-pr document", () => {
		const metadata = renderPrDocument({
			title: "Add profile editing",
			summaryBullets: ["Add profile editing controls."],
			reviewSteps: [{ label: "Editing flow", description: "Verify the form." }],
		});
		const parsed = parsePrMarkdown(metadata.title, metadata.body);
		assert.equal(parsed.title, "Add profile editing");
		assert.deepEqual([...parsed.summaryBullets], ["Add profile editing controls."]);
		assert.equal(parsed.reviewSteps[0]?.label, "Editing flow");
	});

	it("rejects a body that does not start with Summary", () => {
		assert.throws(
			() => parsePrMarkdown("Add profile editing", "Intro\n\n## Summary\n\n- x\n\n## Review guide\n\n1. **A** — B"),
			/must start with a Summary heading/,
		);
	});
});

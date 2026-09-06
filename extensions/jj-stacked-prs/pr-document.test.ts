import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderPrDocument } from "./pr-document.ts";

describe("pr-document", () => {
	it("renders a write-pr document as canonical Summary and Review guide markdown", () => {
		const metadata = renderPrDocument({
			title: "Add profile editing",
			summaryBullets: ["Add profile editing controls."],
			reviewSteps: [{ label: "Editing flow", description: "Verify the form." }],
		});
		assert.equal(metadata.title, "Add profile editing");
		assert.equal(
			metadata.body,
			"## Summary\n\n- Add profile editing controls.\n\n## Review guide\n\n1. **Editing flow** — Verify the form.",
		);
	});

	it("accepts todo prose without treating it as a placeholder", () => {
		assert.equal(
			renderPrDocument({
				title: "Add todo list filter",
				summaryBullets: ["Add todo filtering by status."],
				reviewSteps: [{ label: "Todo filter", description: "Verify todo item display." }],
			}).title,
			"Add todo list filter",
		);
	});

	for (const bullet of ["[TODO] details.", "<TODO> details.", "TBD feature", "Placeholder text."]) {
		it(`rejects the summary placeholder ${JSON.stringify(bullet)}`, () => {
			assert.throws(
				() =>
					renderPrDocument({
						title: "Fix auth",
						summaryBullets: [bullet],
						reviewSteps: [{ label: "Flow", description: "Verify auth." }],
					}),
				/placeholder/,
			);
		});
	}

	for (const title of ["", "x".repeat(121), "Add profile\nediting", "Add profile\rediting", "Add\0profile"]) {
		it(`rejects the malformed title ${JSON.stringify(title)}`, () => {
			assert.throws(
				() =>
					renderPrDocument({
						title,
						summaryBullets: ["Add profile editing."],
						reviewSteps: [{ label: "Flow", description: "Verify editing." }],
					}),
				/single-line/,
			);
		});
	}

	it("rejects placeholder text and malformed titles", () => {
		assert.throws(
			() =>
				renderPrDocument({
					title: "TODO: fix auth",
					summaryBullets: ["Fix auth."],
					reviewSteps: [{ label: "Flow", description: "Test." }],
				}),
			/placeholder/,
		);
		assert.throws(
			() =>
				renderPrDocument({
					title: "Ends with a period.",
					summaryBullets: ["Fix auth."],
					reviewSteps: [{ label: "Flow", description: "Test." }],
				}),
			/no trailing period/,
		);
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveSessionName, nameSessionIfUnnamed } from "./session-name.ts";

describe("workflow session naming", () => {
	it("derives the shared short slug from the task", () => {
		assert.equal(deriveSessionName("\n## Fix archive selection\nMore detail"), "fix-archive-selection");
		assert.equal(deriveSessionName("- Investigate the timeout"), "investigate-timeout");
		assert.equal(deriveSessionName("日本語のアーカイブを修正"), "development-task");
	});

	it("sets a derived name only when the session is unnamed", () => {
		let current: string | undefined;
		const api = {
			getSessionName: () => current,
			setSessionName: (name: string) => {
				current = name;
			},
		};
		assert.equal(nameSessionIfUnnamed(api, "Fix the archive picker"), "fix-archive-picker");
		assert.equal(nameSessionIfUnnamed(api, "Do not replace the name"), undefined);
		assert.equal(current, "fix-archive-picker");
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveSessionName, nameSessionIfUnnamed } from "./session-name.ts";

describe("workflow session naming", () => {
	it("turns the first content line into a short slug", () => {
		assert.equal(deriveSessionName("\n## Fix archive selection\nMore detail"), "fix-archive-selection");
		assert.equal(deriveSessionName("- Investigate the timeout"), "investigate-the-timeout");
		assert.equal(deriveSessionName("Crème brûlée: 日本語"), "creme-brulee");
	});

	it("bounds long slugs without leaving a trailing separator", () => {
		const name = deriveSessionName(
			"Implement deterministic session naming for every delegated development workflow without replacing explicit names",
		);
		assert.ok(name.length <= 48);
		assert.doesNotMatch(name, /-$/);
	});

	it("sets a derived name only when the session is unnamed", () => {
		let current: string | undefined;
		const api = {
			getSessionName: () => current,
			setSessionName: (name: string) => {
				current = name;
			},
		};
		assert.equal(nameSessionIfUnnamed(api, "Fix the archive picker"), "fix-the-archive-picker");
		assert.equal(nameSessionIfUnnamed(api, "Do not replace the name"), undefined);
		assert.equal(current, "fix-the-archive-picker");
	});
});

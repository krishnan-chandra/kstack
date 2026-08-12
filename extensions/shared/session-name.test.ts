import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveSessionName, nameSessionIfUnnamed } from "./session-name.ts";

describe("workflow session naming", () => {
	it("uses the first content line and removes simple Markdown markers", () => {
		assert.equal(deriveSessionName("\n## Fix archive selection\nMore detail"), "Fix archive selection");
		assert.equal(deriveSessionName("- Investigate the timeout"), "Investigate the timeout");
	});

	it("bounds long names at a word boundary", () => {
		const name = deriveSessionName(
			"Implement deterministic session naming for every delegated development workflow without replacing explicit names",
		);
		assert.ok(name.length <= 80);
		assert.match(name, /…$/);
		assert.ok(!name.endsWith("workflow…"));
	});

	it("sets a derived name only when the session is unnamed", () => {
		let current: string | undefined;
		const api = {
			getSessionName: () => current,
			setSessionName: (name: string) => {
				current = name;
			},
		};
		assert.equal(nameSessionIfUnnamed(api, "Fix the archive picker"), "Fix the archive picker");
		assert.equal(nameSessionIfUnnamed(api, "Do not replace the name"), undefined);
		assert.equal(current, "Fix the archive picker");
	});
});

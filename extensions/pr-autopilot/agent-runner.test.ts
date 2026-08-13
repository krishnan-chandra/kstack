import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildChildArgs } from "./agent-runner.ts";

describe("pr-autopilot child isolation", () => {
	it("always disables repository context files", () => {
		const args = buildChildArgs({ model: "provider/model", promptFile: "/tmp/prompt", taskFile: "/tmp/task" });
		assert.ok(args.includes("--no-context-files"));
		assert.ok(args.includes("--no-extensions"));
		assert.ok(args.includes("--no-skills"));
	});
});

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

	it("can pass triage data through stdin with no filesystem tools", () => {
		const args = buildChildArgs({ model: "provider/model", promptFile: "/tmp/prompt", noTools: true });
		assert.ok(args.includes("--no-tools"));
		assert.ok(args.includes("--no-approve"));
		assert.equal(args.includes("/tmp/task"), false);
		assert.equal(args.at(-1), "Use the task supplied on standard input.");
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildParallelAgentArgs } from "./runner.ts";

const baseTask = {
	label: "quality",
	model: "openai/model:high",
	prompt: "review",
	cwd: "/repo",
} as const;

describe("parallel agent child arguments", () => {
	it("enforces the read-only tool boundary for Simplify", () => {
		const args = buildParallelAgentArgs({ ...baseTask, access: "read-only" });
		assert.deepEqual(args.slice(0, 7), [
			"--mode",
			"json",
			"-p",
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
		]);
		assert.deepEqual(args.slice(7), ["--tools", "read,grep,find,ls", "--model", "openai/model:high"]);
	});

	it("allows mutation tools only for isolated Arena workspaces", () => {
		const args = buildParallelAgentArgs({ ...baseTask, access: "workspace" });
		assert.ok(args.includes("read,grep,find,ls,write,edit,bash"));
		assert.ok(args.includes("--no-context-files"));
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandDiagnostic, type ExecFn, runCommand } from "./git-exec.ts";

describe("shared Git command execution", () => {
	it("forwards cancellation and timeout options", async () => {
		const signal = new AbortController().signal;
		let seenSignal: AbortSignal | undefined;
		let seenTimeout: number | undefined;
		const exec: ExecFn = async (_command, _args, options) => {
			seenSignal = options.signal;
			seenTimeout = options.timeout;
			return { code: 0, stdout: "ok", stderr: "" };
		};
		assert.equal((await runCommand(exec, "git", ["status"], "/repo", signal, 8_000)).stdout, "ok");
		assert.equal(seenSignal, signal);
		assert.equal(seenTimeout, 8_000);
	});

	it("normalizes spawn failures and selects a useful diagnostic", async () => {
		const exec: ExecFn = async () => {
			throw new Error("spawn failed");
		};
		const result = await runCommand(exec, "git", ["status"], "/repo");
		assert.equal(result.code, 1);
		assert.equal(commandDiagnostic(result), "spawn failed");
	});
});

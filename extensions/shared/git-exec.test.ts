import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commandDiagnostic, type ExecFn, makeExec, runCommand } from "./git-exec.ts";

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
		assert.equal(result.killed, undefined);
	});

	it("fails closed when a killed command reports exit zero", async () => {
		const exec: ExecFn = async () => ({ code: 0, stdout: "", stderr: "timed out", killed: true });
		const result = await runCommand(exec, "git", ["rebase", "main"], "/repo");
		assert.equal(result.code, 1);
		assert.equal(result.killed, true);
		assert.equal(commandDiagnostic(result), "timed out");
	});

	it("surfaces killed from pi.exec", async () => {
		const pi = {
			exec: async () => ({ code: 0, stdout: "", stderr: "timed out", killed: true }),
		};
		const exec = makeExec(
			/* SAFETY: This fixture exercises only the exec method. */
			pi as never,
		);
		const result = await exec("git", ["status"], { cwd: "/repo" });
		assert.equal(result.killed, true);
	});
});

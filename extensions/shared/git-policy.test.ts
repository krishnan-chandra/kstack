import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecFn } from "./git-exec.ts";
import { GitBackend } from "./vcs/git-backend.ts";

function fakeExec(responses: Record<string, { code?: number; stdout?: string; stderr?: string }>) {
	const calls: string[] = [];
	const exec: ExecFn = async (_command, args) => {
		const key = args.join(" ");
		calls.push(key);
		const response = responses[key] ?? {};
		return { code: response.code ?? 0, stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
	};
	return { exec, calls };
}
describe("remote head synchronization", () => {
	it("fetches and resolves the remote head without merging it", async () => {
		const remote = "3".repeat(40);
		const { exec, calls } = fakeExec({
			"fetch origin feature": {},
			"rev-parse origin/feature": { stdout: `${remote}\n` },
		});
		assert.deepEqual(await new GitBackend(exec).fetchRemoteHead("/repo", "feature"), { ok: true, sha: remote });
		assert.deepEqual(calls, ["fetch origin feature", "rev-parse origin/feature"]);
	});
});

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

describe("current workstream branch policy", () => {
	it("refuses a dirty tree before creating a branch", async () => {
		const { exec, calls } = fakeExec({ "status --porcelain=v1 --untracked-files=all": { stdout: "?? notes.txt\n" } });
		const result = await new GitBackend(exec).createWorkstream("/repo", "Add search");
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /working tree is dirty/i);
		assert.equal(
			calls.some((call) => call.startsWith("switch -c")),
			false,
		);
	});

	it("creates a unique task branch and records its base", async () => {
		const base = "1".repeat(40);
		const { exec, calls } = fakeExec({
			"status --porcelain=v1 --untracked-files=all": {},
			"rev-parse HEAD": { stdout: `${base}\n` },
			"show-ref --verify --quiet refs/heads/kstack/add-search": {},
			"show-ref --verify --quiet refs/heads/kstack/add-search-2": { code: 1 },
			"switch -c kstack/add-search-2": {},
		});
		const result = await new GitBackend(exec).createWorkstream("/repo", "Add search");
		assert.deepEqual(result, { ok: true, ref: "kstack/add-search-2", baseSha: base });
		assert.ok(calls.includes("switch -c kstack/add-search-2"));
	});
});

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

describe("committed workstream postcondition", () => {
	it("requires the expected branch, a new commit, and a clean tree", async () => {
		const base = "1".repeat(40);
		const head = "2".repeat(40);
		const { exec } = fakeExec({
			"branch --show-current": { stdout: "kstack/add-search\n" },
			"rev-parse HEAD": { stdout: `${head}\n` },
			"status --porcelain=v1 --untracked-files=all": {},
		});
		assert.deepEqual(
			await new GitBackend(exec).verifyCommittedWorkstream("/repo", {
				ref: "kstack/add-search",
				baseSha: base,
				requireNewCommit: true,
			}),
			{ ok: true, headSha: head },
		);
	});

	it("rejects uncommitted files", async () => {
		const sha = "2".repeat(40);
		const { exec } = fakeExec({
			"branch --show-current": { stdout: "kstack/add-search\n" },
			"rev-parse HEAD": { stdout: `${sha}\n` },
			"status --porcelain=v1 --untracked-files=all": { stdout: " M src/search.ts\n" },
		});
		const result = await new GitBackend(exec).verifyCommittedWorkstream("/repo", {
			ref: "kstack/add-search",
			baseSha: "1".repeat(40),
			requireNewCommit: false,
		});
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /uncommitted files/i);
	});
});

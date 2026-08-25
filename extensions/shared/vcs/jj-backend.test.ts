import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecFn, ExecFnResult } from "../git-exec.ts";
import { createVcsBackend } from "./factory.ts";
import { filesetPath, JjBackend } from "./jj-backend.ts";

interface Step {
	command: string;
	args: string[];
	result?: Partial<ExecFnResult>;
}

function scriptedExec(steps: Step[]): ExecFn {
	return async (command, args) => {
		const step = steps.shift();
		assert.ok(step, `unexpected command: ${command} ${args.join(" ")}`);
		assert.equal(command, step.command);
		assert.deepEqual(args, step.args);
		return { code: step.result?.code ?? 0, stdout: step.result?.stdout ?? "", stderr: step.result?.stderr ?? "" };
	};
}

const noPager = (args: string[]): string[] => ["--no-pager", ...args];
const commitTemplate = 'commit_id ++ "\\n"';
const changeTemplate = 'change_id ++ "\\n"';
const localBookmarkTemplate = 'if(self.remote(), "", self.name() ++ "\\n")';
const bookmarkTargetTemplate =
	'if(self.remote(), "", self.name() ++ "\\t" ++ self.normal_target().commit_id() ++ "\\n")';

describe("JjBackend references and workstreams", () => {
	it("reports a change ID when no bookmark targets the working-copy commit", async () => {
		const exec = scriptedExec([
			{
				command: "jj",
				args: noPager(["bookmark", "list", "-r", "@", "-T", localBookmarkTemplate]),
			},
			{
				command: "jj",
				args: noPager(["log", "-r", "@", "--no-graph", "-T", changeTemplate]),
				result: { stdout: "abcdefghijklmno\n" },
			},
		]);
		assert.deepEqual(await new JjBackend(exec).currentRef("/repo"), {
			ok: true,
			ref: { kind: "no-bookmark", changeId: "abcdefghijklmno" },
		});
	});

	it("identifies a bookmarked workstream by stable change and parent commits", async () => {
		const parent = "1".repeat(40);
		const exec = scriptedExec([
			{
				command: "jj",
				args: noPager(["bookmark", "list", "-r", "@", "-T", localBookmarkTemplate]),
				result: { stdout: "feature\n" },
			},
			{
				command: "jj",
				args: noPager(["log", "-r", "@", "--no-graph", "-T", changeTemplate]),
				result: { stdout: "stable-change-id\n" },
			},
			{
				command: "jj",
				args: noPager(["log", "-r", "parents(@)", "--no-graph", "-T", commitTemplate]),
				result: { stdout: `${parent}\n` },
			},
		]);
		assert.deepEqual(await new JjBackend(exec).captureWorkstream("/repo"), {
			ok: true,
			snapshot: { ref: "feature", token: `feature@stable-change-id/parents:${parent}` },
		});
	});

	it("creates a trunk-based change with a collision-safe task bookmark", async () => {
		const base = "1".repeat(40);
		const exec = scriptedExec([
			{
				command: "jj",
				args: noPager(["log", "-r", "trunk()", "--no-graph", "-T", commitTemplate]),
				result: { stdout: `${base}\n` },
			},
			{
				command: "jj",
				args: noPager(["bookmark", "list", "--all-remotes", "exact:kstack/add-search", "-T", 'name ++ "\\n"']),
				result: { stdout: "kstack/add-search\n" },
			},
			{
				command: "jj",
				args: noPager(["bookmark", "list", "--all-remotes", "exact:kstack/add-search-2", "-T", 'name ++ "\\n"']),
			},
			{ command: "jj", args: noPager(["new", "trunk()", "-m", "Add search"]) },
			{ command: "jj", args: noPager(["bookmark", "create", "kstack/add-search-2", "-r", "@"]) },
		]);
		assert.deepEqual(await new JjBackend(exec).createWorkstream("/repo", "Add search"), {
			ok: true,
			ref: "kstack/add-search-2",
			baseSha: base,
		});
	});

	it("verifies bookmark ancestry, a non-empty change, and an empty working-copy commit", async () => {
		const base = "1".repeat(40);
		const bookmark = "2".repeat(40);
		const head = "3".repeat(40);
		const exec = scriptedExec([
			{
				command: "jj",
				args: noPager(["bookmark", "list", "exact:add-search", "-T", bookmarkTargetTemplate]),
				result: { stdout: `add-search\t${bookmark}\n` },
			},
			{
				command: "jj",
				args: noPager(["log", "-r", `${bookmark} & ::@`, "--no-graph", "-T", commitTemplate]),
				result: { stdout: `${bookmark}\n` },
			},
			{
				command: "jj",
				args: noPager(["log", "-r", `${base}..@ & ~empty()`, "--no-graph", "-T", commitTemplate]),
				result: { stdout: `${bookmark}\n` },
			},
			{
				command: "jj",
				args: noPager(["log", "-r", "@", "--no-graph", "-T", 'if(empty, "true", "false")']),
				result: { stdout: "true" },
			},
			{
				command: "jj",
				args: noPager(["log", "-r", "@", "--no-graph", "-T", commitTemplate]),
				result: { stdout: `${head}\n` },
			},
		]);
		assert.deepEqual(
			await new JjBackend(exec).verifyRecordedWorkstream("/repo", {
				ref: "add-search",
				baseSha: base,
				requireNewCommit: true,
			}),
			{ ok: true, headSha: head },
		);
	});
});

describe("JjBackend mutations", () => {
	it("quotes literal cwd-relative paths as jj filesets", () => {
		assert.deepEqual(["plain.ts", "a b.txt", "tilde~x", 'qu"ote', "back\\slash", "-rf"].map(filesetPath), [
			'cwd:"plain.ts"',
			'cwd:"a b.txt"',
			'cwd:"tilde~x"',
			'cwd:"qu\\"ote"',
			'cwd:"back\\\\slash"',
			'cwd:"-rf"',
		]);
	});

	it("uses escaped jj filesets for path-scoped commit and restore commands", async () => {
		const exec = scriptedExec([
			{ command: "jj", args: noPager(["commit", 'cwd:"a.ts"', 'cwd:"b.ts"', "-m", "Apply fixes"]) },
			{ command: "jj", args: noPager(["restore", 'cwd:"forbidden.txt"']) },
			{ command: "jj", args: noPager(["commit", 'cwd:"tilde~x"', "-m", "Apply hostile path"]) },
		]);
		const backend = new JjBackend(exec);
		assert.deepEqual(await backend.recordPaths("/repo", ["a.ts", "b.ts"], "Apply fixes"), { ok: true });
		assert.deepEqual(await backend.restorePaths("/repo", ["forbidden.txt"]), { ok: true });
		assert.deepEqual(await backend.recordPaths("/repo", ["tilde~x"], "Apply hostile path"), { ok: true });
	});

	it("moves the task bookmark to the current checkpoint before pushing", async () => {
		const exec = scriptedExec([
			{
				command: "jj",
				args: noPager(["log", "-r", "@", "--no-graph", "-T", 'description.first_line() ++ "\\n"']),
			},
			{
				command: "jj",
				args: noPager(["log", "-r", "@", "--no-graph", "-T", 'if(empty, "true", "false")']),
				result: { stdout: "true" },
			},
			{ command: "jj", args: noPager(["describe", "-m", "Automation checkpoint for feature"]) },
			{ command: "jj", args: noPager(["bookmark", "set", "feature", "-r", "@"]) },
			{ command: "jj", args: noPager(["git", "push", "--remote", "origin", "--bookmark", "feature"]) },
		]);
		assert.deepEqual(await new JjBackend(exec).publishRecordedChanges("/repo", "feature"), { ok: true });
	});

	it("restores the pre-merge change when a base merge conflicts", async () => {
		const remote = "4".repeat(40);
		const steps: Step[] = [
			{ command: "jj", args: noPager(["git", "fetch", "--remote", "origin"]) },
			{
				command: "jj",
				args: noPager(["log", "-r", "main@origin", "--no-graph", "-T", commitTemplate]),
				result: { stdout: `${remote}\n` },
			},
			{
				command: "jj",
				args: noPager(["log", "-r", `${remote} & ::@`, "--no-graph", "-T", commitTemplate]),
			},
			{
				command: "jj",
				args: noPager(["bookmark", "list", "-r", "@", "-T", localBookmarkTemplate]),
				result: { stdout: "feature\n" },
			},
			{
				command: "jj",
				args: noPager(["log", "-r", "@", "--no-graph", "-T", changeTemplate]),
				result: { stdout: "pre-merge-change\n" },
			},
			{ command: "jj", args: noPager(["new", "@", "main@origin", "-m", "Merge main@origin"]) },
			{
				command: "jj",
				args: noPager(["log", "-r", "@", "--no-graph", "-T", changeTemplate]),
				result: { stdout: "merge-change\n" },
			},
			{
				command: "jj",
				args: noPager(["log", "-r", "@", "--no-graph", "-T", 'if(conflict, "true", "false")']),
				result: { stdout: "true\n" },
			},
			{ command: "jj", args: noPager(["resolve", "--list"]), result: { stdout: "src/a.ts\n" } },
			{ command: "jj", args: noPager(["edit", "pre-merge-change"]) },
			{ command: "jj", args: noPager(["abandon", "merge-change"]) },
		];
		assert.deepEqual(await new JjBackend(scriptedExec(steps)).updateBase("/repo", "main"), {
			kind: "needs-human",
			files: ["src/a.ts"],
			error: "Merge conflicted in src/a.ts. Competing intents need a human.",
		});
		assert.equal(steps.length, 0);
	});

	it("reports manual recovery when restoring the pre-merge change fails", async () => {
		const remote = "4".repeat(40);
		const steps: Step[] = [
			{ command: "jj", args: noPager(["git", "fetch", "--remote", "origin"]) },
			{
				command: "jj",
				args: noPager(["log", "-r", "main@origin", "--no-graph", "-T", commitTemplate]),
				result: { stdout: `${remote}\n` },
			},
			{
				command: "jj",
				args: noPager(["log", "-r", `${remote} & ::@`, "--no-graph", "-T", commitTemplate]),
			},
			{
				command: "jj",
				args: noPager(["bookmark", "list", "-r", "@", "-T", localBookmarkTemplate]),
				result: { stdout: "feature\n" },
			},
			{
				command: "jj",
				args: noPager(["log", "-r", "@", "--no-graph", "-T", changeTemplate]),
				result: { stdout: "pre-merge-change\n" },
			},
			{ command: "jj", args: noPager(["new", "@", "main@origin", "-m", "Merge main@origin"]) },
			{
				command: "jj",
				args: noPager(["log", "-r", "@", "--no-graph", "-T", changeTemplate]),
				result: { stdout: "merge-change\n" },
			},
			{
				command: "jj",
				args: noPager(["log", "-r", "@", "--no-graph", "-T", 'if(conflict, "true", "false")']),
				result: { stdout: "true\n" },
			},
			{ command: "jj", args: noPager(["resolve", "--list"]), result: { stdout: "src/a.ts\n" } },
			{
				command: "jj",
				args: noPager(["edit", "pre-merge-change"]),
				result: { code: 1, stderr: "edit failed\n" },
			},
		];
		const result = await new JjBackend(scriptedExec(steps)).updateBase("/repo", "main");
		assert.equal(result.kind, "needs-human");
		assert.match(result.error, /jj op log and jj op restore/);
		assert.equal(steps.length, 0);
	});

	it("does not start a base merge without a pre-merge recovery anchor", async () => {
		const remote = "4".repeat(40);
		const steps: Step[] = [
			{ command: "jj", args: noPager(["git", "fetch", "--remote", "origin"]) },
			{
				command: "jj",
				args: noPager(["log", "-r", "main@origin", "--no-graph", "-T", commitTemplate]),
				result: { stdout: `${remote}\n` },
			},
			{
				command: "jj",
				args: noPager(["log", "-r", `${remote} & ::@`, "--no-graph", "-T", commitTemplate]),
			},
			{
				command: "jj",
				args: noPager(["bookmark", "list", "-r", "@", "-T", localBookmarkTemplate]),
				result: { stdout: "feature\n" },
			},
			{
				command: "jj",
				args: noPager(["log", "-r", "@", "--no-graph", "-T", changeTemplate]),
				result: { code: 1, stderr: "cannot read change\n" },
			},
		];
		const result = await new JjBackend(scriptedExec(steps)).updateBase("/repo", "main");
		assert.deepEqual(result, {
			kind: "failed",
			error: "Could not capture the pre-merge jj change: cannot read change",
		});
		assert.equal(steps.length, 0);
	});

	it("fetches and reports the remote head without rewriting the current change", async () => {
		const remote = "4".repeat(40);
		const exec = scriptedExec([
			{ command: "jj", args: noPager(["git", "fetch", "--remote", "origin"]) },
			{
				command: "jj",
				args: noPager(["log", "-r", "feature@origin", "--no-graph", "-T", commitTemplate]),
				result: { stdout: `${remote}\n` },
			},
		]);
		assert.deepEqual(await new JjBackend(exec).fetchRemoteHead("/repo", "feature"), {
			ok: true,
			sha: remote,
		});
	});
});

describe("configured VCS child policy", () => {
	it("selects exactly the configured implementation", () => {
		const exec = scriptedExec([]);
		assert.equal(createVcsBackend("git", exec).id, "git");
		assert.equal(createVcsBackend("jj", exec).id, "jj");
	});
});

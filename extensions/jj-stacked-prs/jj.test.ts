import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJjAdapter, parseBookmarkLines, parseStackCommits } from "./jj.ts";

describe("jj adapters", () => {
	it("parses local bookmark rows and rejects malformed or duplicate output", () => {
		assert.deepEqual(parseBookmarkLines("feat1\tabc\nfeat2\tdef\n"), [
			{ name: "feat1", commitId: "abc" },
			{ name: "feat2", commitId: "def" },
		]);
		assert.throws(() => parseBookmarkLines("feat1"), /Malformed/);
		assert.throws(() => parseBookmarkLines("feat1\tabc\nfeat1\tabc\n"), /Duplicate/);
	});

	it("validates stack JSON and keeps full ids", () => {
		const commits = parseStackCommits(
			'{"change_id":"abcdefghijklmnopqrstuvwxyz","commit_id":"0123456789abcdef0123456789abcdef01234567","subject":"feat","empty":false,"conflict":false,"divergent":false,"merge":false,"bookmarks":["feat1"],"remote_bookmarks":[],"parents":["trunk"]}',
		);
		assert.equal(commits[0].changeId.length, 26);
		assert.equal(commits[0].commitId.length, 40);
		assert.throws(() => parseStackCommits('{"change_id":"a"}'), /missing commit_id/);
	});

	it("quotes bookmark names as exact revsets for mutation", async () => {
		const calls: string[][] = [];
		const adapter = createJjAdapter(async (argv) => {
			calls.push([...argv]);
			return { kind: "ok", code: 0, stdout: "", stderr: "" };
		});
		await adapter.rebaseStack(".", "feat|all()", "abc");
		await adapter.abandonRange(".", "abc", "feat|all()");
		await adapter.isAncestor(".", "deadbeef", "cafebabe");
		assert.deepEqual(calls, [
			["jj", "rebase", "-b", 'bookmarks(exact:"feat|all()")', "-o", "abc"],
			["jj", "abandon", '(abc)..bookmarks(exact:"feat|all()")'],
			["jj", "log", "-r", "deadbeef & ::cafebabe", "--no-graph", "--no-pager", "-T", 'commit_id ++ "\\n"'],
		]);
	});

	it("reads working-copy status and rejects malformed rows", async () => {
		const calls: string[][] = [];
		const byOutput = (stdout: string) =>
			createJjAdapter(async (argv) => {
				calls.push([...argv]);
				return { kind: "ok", code: 0, stdout, stderr: "" };
			}).workingCopyStatus(".");
		assert.deepEqual(await byOutput('abc123\ttrue\tfalse\t["parent"]\n'), {
			commitId: "abc123",
			empty: true,
			bookmarked: false,
			parentCommitIds: ["parent"],
		});
		assert.deepEqual(await byOutput('abc123\tfalse\ttrue\t["left","right"]\n'), {
			commitId: "abc123",
			empty: false,
			bookmarked: true,
			parentCommitIds: ["left", "right"],
		});
		assert.equal(await byOutput(""), undefined);
		assert.equal(await byOutput('abc123\tmaybe\tfalse\t["parent"]\n'), undefined);
		assert.equal(await byOutput("abc123\ttrue\tfalse\tnot-json\n"), undefined);
		assert.equal(await byOutput('a\ttrue\tfalse\t["p"]\nb\ttrue\tfalse\t["p"]\n'), undefined);
		const template = calls[0][calls[0].indexOf("-T") + 1];
		assert.match(template, /local_bookmarks\.len\(\) > 0/);
	});

	it("surfaces working-copy status command failures", async () => {
		const adapter = createJjAdapter(async () => ({
			kind: "nonzero",
			code: 1,
			stdout: "",
			stderr: "template error",
			message: "template error",
		}));
		await assert.rejects(() => adapter.workingCopyStatus("."), /template error/);
	});

	it("rebases the working copy onto a bounded commit id", async () => {
		const calls: string[][] = [];
		const adapter = createJjAdapter(async (argv) => {
			calls.push([...argv]);
			return { kind: "ok", code: 0, stdout: "", stderr: "" };
		});
		await adapter.rebaseWorkingCopy(".", "deadbeef");
		assert.deepEqual(calls, [["jj", "rebase", "-r", "@", "-d", "deadbeef"]]);
		await assert.rejects(() => adapter.rebaseWorkingCopy(".", "x".repeat(10_000)), /commit id/);
	});

	it("does not treat this repository's current trunk as a fixture", () => {
		const commits = parseStackCommits(
			'{"change_id":"aaa","commit_id":"111","subject":"feat","empty":false,"conflict":false,"divergent":false,"merge":false,"bookmarks":["feat1"],"remote_bookmarks":[],"parents":["independent-trunk"]}',
		);
		assert.equal(commits[0].parentCommitIds[0], "independent-trunk");
		assert.notEqual(commits[0].parentCommitIds[0], "c81cd2b3268964e1dd2767749ace32f6fa03837c");
	});
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExecFn } from "../shared/git-exec.ts";
import { createVcsTestEnv } from "../shared/vcs-test-env.ts";
import { inspectRebaseScope, type RebaseScopeBranch, verifyRebasedScope } from "./rebase-scope.ts";

interface GitFixture {
	root: string;
	repo: string;
	env: NodeJS.ProcessEnv;
	oldFrontier: string;
	oldMiddle: string;
	oldTop: string;
	refreshedTrunk: string;
}

function createRealExec(env: NodeJS.ProcessEnv): ExecFn {
	return (command, args, options) => {
		const completed = spawnSync(command, args, {
			cwd: options.cwd,
			encoding: "utf8",
			env,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: options.timeout,
		});
		return Promise.resolve({
			code: completed.status ?? 1,
			stdout: completed.stdout,
			stderr: completed.stderr || completed.error?.message || "",
		});
	};
}

function runGit(fixture: Pick<GitFixture, "repo" | "env">, args: string[], cwd = fixture.repo): string {
	const completed = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: fixture.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	assert.equal(completed.status, 0, completed.stderr || completed.error?.message);
	return completed.stdout.trim();
}

function commitFile(
	fixture: Pick<GitFixture, "repo" | "env">,
	name: string,
	contents: string,
	message: string,
): string {
	writeFileSync(join(fixture.repo, name), contents, "utf8");
	runGit(fixture, ["add", name]);
	runGit(fixture, ["commit", "-qm", message]);
	return runGit(fixture, ["rev-parse", "HEAD"]);
}

function createFixture(): GitFixture {
	const root = mkdtempSync(join(tmpdir(), "github-rebase-scope-"));
	const repo = join(root, "repo");
	mkdirSync(repo);
	const env = createVcsTestEnv(root);
	const partial = { repo, env };
	runGit(partial, ["init", "-q"]);
	commitFile(partial, "base.txt", "base\n", "base");
	runGit(partial, ["branch", "-M", "main"]);
	const base = runGit(partial, ["rev-parse", "HEAD"]);
	runGit(partial, ["switch", "-qc", "kstack/one"]);
	const oldFrontier = commitFile(partial, "one.txt", "one\n", "one");
	runGit(partial, ["switch", "-qc", "kstack/two"]);
	const oldMiddle = commitFile(partial, "two.txt", "two\n", "two");
	runGit(partial, ["switch", "-qc", "kstack/three"]);
	const oldTop = commitFile(partial, "three.txt", "three\n", "three");
	runGit(partial, ["switch", "-qc", "refreshed-main", base]);
	const refreshedTrunk = commitFile(partial, "merged.txt", "merged\n", "merged frontier");
	runGit(partial, ["switch", "-q", "kstack/three"]);
	return { root, repo, env, oldFrontier, oldMiddle, oldTop, refreshedTrunk };
}

function readHeads(fixture: GitFixture): Map<string, string> {
	const output = runGit(fixture, ["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads"]);
	return new Map(
		output.split("\n").map((line) => {
			const [branch, sha] = line.split("\t");
			return [branch, sha];
		}),
	);
}

function remainderPins(fixture: GitFixture): RebaseScopeBranch[] {
	return [
		{ branch: "kstack/two", sha: fixture.oldMiddle },
		{ branch: "kstack/three", sha: fixture.oldTop },
	];
}

async function inspectFixture(fixture: GitFixture) {
	return inspectRebaseScope({
		cwd: fixture.repo,
		frontierSha: fixture.oldFrontier,
		remainder: remainderPins(fixture),
		deps: { exec: createRealExec(fixture.env) },
	});
}

function rebaseTop(fixture: GitFixture): void {
	runGit(fixture, ["rebase", "--onto", fixture.refreshedTrunk, fixture.oldFrontier, "kstack/three", "--update-refs"]);
}

describe("real Git rebase --update-refs scope", () => {
	it("updates each remainder branch when only the top is checked out in the initiating worktree", () => {
		const fixture = createFixture();
		try {
			const before = readHeads(fixture);
			rebaseTop(fixture);
			const after = readHeads(fixture);

			assert.equal(before.get("kstack/one"), fixture.oldFrontier);
			assert.equal(after.get("kstack/one"), fixture.oldFrontier);
			assert.notEqual(after.get("kstack/two"), fixture.oldMiddle);
			assert.notEqual(after.get("kstack/three"), fixture.oldTop);
			assert.equal(after.get("main"), before.get("main"));
			assert.equal(after.get("refreshed-main"), before.get("refreshed-main"));
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("leaves an intermediate remainder branch unchanged when another worktree checks it out", () => {
		const fixture = createFixture();
		try {
			const middleWorktree = join(fixture.root, "middle worktree\nwith newline");
			runGit(fixture, ["worktree", "add", "-q", middleWorktree, "kstack/two"]);
			const before = readHeads(fixture);
			rebaseTop(fixture);
			const after = readHeads(fixture);

			assert.equal(after.get("kstack/two"), fixture.oldMiddle);
			assert.notEqual(after.get("kstack/three"), fixture.oldTop);
			assert.equal(after.get("main"), before.get("main"));
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("moves an unrelated alias whose tip is inside the rewritten range", () => {
		const fixture = createFixture();
		try {
			runGit(fixture, ["branch", "local-alias", fixture.oldMiddle]);
			const before = readHeads(fixture);
			rebaseTop(fixture);
			const after = readHeads(fixture);

			assert.equal(before.get("local-alias"), fixture.oldMiddle);
			assert.notEqual(after.get("local-alias"), fixture.oldMiddle);
			assert.equal(after.get("local-alias"), after.get("kstack/two"));
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});
});

describe("landing rebase scope inspection", () => {
	it("accepts the real supported topology and verifies the rewritten refs", async () => {
		const fixture = createFixture();
		try {
			const inspected = await inspectFixture(fixture);
			assert.equal(inspected.ok, true);
			if (!inspected.ok) return;

			rebaseTop(fixture);
			const verified = await verifyRebasedScope({
				cwd: fixture.repo,
				refreshedTrunkSha: fixture.refreshedTrunk,
				before: inspected.value,
				deps: { exec: createRealExec(fixture.env) },
			});
			assert.equal(verified.ok, true);
			if (!verified.ok) return;
			assert.notEqual(verified.value.get("kstack/two"), fixture.oldMiddle);
			assert.notEqual(verified.value.get("kstack/three"), fixture.oldTop);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("rejects an intermediate branch checked out at a path with spaces and a newline", async () => {
		const fixture = createFixture();
		try {
			const middleWorktree = join(fixture.root, "middle worktree\nwith newline");
			runGit(fixture, ["worktree", "add", "-q", middleWorktree, "kstack/two"]);
			const inspected = await inspectFixture(fixture);
			assert.equal(inspected.ok, false);
			if (inspected.ok) return;
			assert.match(inspected.error, /kstack\/two.*middle worktree\\nwith newline/);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("rejects the top checked out in another worktree", async () => {
		const fixture = createFixture();
		try {
			runGit(fixture, ["switch", "-q", "main"]);
			const topWorktree = join(fixture.root, "top worktree");
			runGit(fixture, ["worktree", "add", "-q", topWorktree, "kstack/three"]);
			const inspected = await inspectFixture(fixture);
			assert.equal(inspected.ok, false);
			if (inspected.ok) return;
			assert.match(inspected.error, /Top branch kstack\/three is checked out in another worktree/);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("rejects aliases on interior and top commits but allows aliases outside the range", async () => {
		const fixture = createFixture();
		try {
			runGit(fixture, ["branch", "outside-alias", fixture.oldFrontier]);
			const outside = await inspectFixture(fixture);
			assert.equal(outside.ok, true);

			runGit(fixture, ["branch", "interior-alias", fixture.oldMiddle]);
			const interior = await inspectFixture(fixture);
			assert.equal(interior.ok, false);
			if (!interior.ok) assert.match(interior.error, /interior-alias.*rewrite range/);
			runGit(fixture, ["branch", "-D", "interior-alias"]);

			runGit(fixture, ["branch", "top-alias", fixture.oldTop]);
			const top = await inspectFixture(fixture);
			assert.equal(top.ok, false);
			if (!top.ok) assert.match(top.error, /top-alias.*rewrite range/);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("rejects a pinned remainder branch that is absent or moved", async () => {
		const fixture = createFixture();
		try {
			runGit(fixture, ["branch", "-D", "kstack/two"]);
			const absent = await inspectFixture(fixture);
			assert.equal(absent.ok, false);
			if (!absent.ok) assert.match(absent.error, /kstack\/two.*missing/);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}

		const movedFixture = createFixture();
		try {
			commitFile(movedFixture, "four.txt", "four\n", "move top");
			const moved = await inspectFixture(movedFixture);
			assert.equal(moved.ok, false);
			if (!moved.ok) assert.match(moved.error, /kstack\/three moved from pinned head/);
		} finally {
			rmSync(movedFixture.root, { recursive: true, force: true });
		}
	});

	it("rejects a merge commit in the pinned range", async () => {
		const fixture = createFixture();
		try {
			runGit(fixture, ["switch", "-qc", "side", fixture.oldMiddle]);
			commitFile(fixture, "side.txt", "side\n", "side");
			runGit(fixture, ["switch", "-q", "kstack/three"]);
			runGit(fixture, ["merge", "--no-ff", "-qm", "merge side", "side"]);
			const mergedTop = runGit(fixture, ["rev-parse", "HEAD"]);
			const inspected = await inspectRebaseScope({
				cwd: fixture.repo,
				frontierSha: fixture.oldFrontier,
				remainder: [
					{ branch: "kstack/two", sha: fixture.oldMiddle },
					{ branch: "kstack/three", sha: mergedTop },
				],
				deps: { exec: createRealExec(fixture.env) },
			});
			assert.equal(inspected.ok, false);
			if (!inspected.ok) assert.match(inspected.error, /contains a merge commit/);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("accepts a no-op rebase when ancestry and outside refs stay valid", async () => {
		const fixture = createFixture();
		try {
			const inspected = await inspectFixture(fixture);
			assert.equal(inspected.ok, true);
			if (!inspected.ok) return;
			runGit(fixture, ["rebase", "--onto", fixture.oldFrontier, fixture.oldFrontier, "kstack/three", "--update-refs"]);
			const verified = await verifyRebasedScope({
				cwd: fixture.repo,
				refreshedTrunkSha: fixture.oldFrontier,
				before: inspected.value,
				deps: { exec: createRealExec(fixture.env) },
			});
			assert.equal(verified.ok, true);
			if (verified.ok) {
				assert.equal(verified.value.get("kstack/two"), fixture.oldMiddle);
				assert.equal(verified.value.get("kstack/three"), fixture.oldTop);
			}
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}
	});

	it("detects an outside ref movement and a newly added ref after rebase", async () => {
		const fixture = createFixture();
		try {
			runGit(fixture, ["branch", "outside", fixture.oldFrontier]);
			const inspected = await inspectFixture(fixture);
			assert.equal(inspected.ok, true);
			if (!inspected.ok) return;
			runGit(fixture, ["branch", "-f", "outside", fixture.refreshedTrunk]);
			const moved = await verifyRebasedScope({
				cwd: fixture.repo,
				refreshedTrunkSha: fixture.oldFrontier,
				before: inspected.value,
				deps: { exec: createRealExec(fixture.env) },
			});
			assert.equal(moved.ok, false);
			if (!moved.ok) assert.match(moved.error, /outside moved.*during rebase/);
		} finally {
			rmSync(fixture.root, { recursive: true, force: true });
		}

		const addedFixture = createFixture();
		try {
			const inspected = await inspectFixture(addedFixture);
			assert.equal(inspected.ok, true);
			if (!inspected.ok) return;
			runGit(addedFixture, ["branch", "new-alias", addedFixture.oldFrontier]);
			const added = await verifyRebasedScope({
				cwd: addedFixture.repo,
				refreshedTrunkSha: addedFixture.oldFrontier,
				before: inspected.value,
				deps: { exec: createRealExec(addedFixture.env) },
			});
			assert.equal(added.ok, false);
			if (!added.ok) assert.match(added.error, /Unexpected local branch new-alias appeared/);
		} finally {
			rmSync(addedFixture.root, { recursive: true, force: true });
		}
	});
});

const fakeFrontier = "1".repeat(40);
const fakeMiddle = "2".repeat(40);
const fakeTop = "3".repeat(40);
const fakeTrunk = "4".repeat(40);
const refsCommand = "git for-each-ref --format=%(refname)%09%(objectname) refs/heads";
const worktreesCommand = "git worktree list --porcelain -z";

function fakeRefInventory(items: ReadonlyArray<readonly [string, string]>): string {
	return `${items.map(([branch, sha]) => `refs/heads/${branch}\t${sha}`).join("\n")}\n`;
}

function fakeWorktree(path = "/repo with space\nand newline", branch = "kstack/top", head = fakeTop): string {
	return `worktree ${path}\0HEAD ${head}\0branch refs/heads/${branch}\0\0`;
}

function fakeScopeExec(overrides: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}): ExecFn {
	return async (command, args) => {
		const key = `${command} ${args.join(" ")}`;
		const values = new Map<string, { code?: number; stdout?: string; stderr?: string }>([
			[
				refsCommand,
				{
					stdout: fakeRefInventory([
						["frontier", fakeFrontier],
						["kstack/middle", fakeMiddle],
						["kstack/top", fakeTop],
					]),
				},
			],
			[worktreesCommand, { stdout: fakeWorktree() }],
			[`git merge-base --is-ancestor ${fakeFrontier} ${fakeTop}`, {}],
			[`git rev-list --reverse ${fakeFrontier}..${fakeTop}`, { stdout: `${fakeMiddle}\n${fakeTop}\n` }],
			[`git rev-list --min-parents=2 ${fakeFrontier}..${fakeTop}`, {}],
			[`git merge-base --is-ancestor ${fakeTrunk} ${fakeTop}`, {}],
			[`git rev-list --reverse ${fakeTrunk}..${fakeTop}`, { stdout: `${fakeMiddle}\n${fakeTop}\n` }],
		]);
		const value = overrides[key] ?? values.get(key) ?? {};
		return { code: value.code ?? 0, stdout: value.stdout ?? "", stderr: value.stderr ?? "" };
	};
}

async function inspectFakeScope(exec = fakeScopeExec()) {
	return inspectRebaseScope({
		cwd: "/repo-link",
		frontierSha: fakeFrontier,
		remainder: [
			{ branch: "kstack/middle", sha: fakeMiddle },
			{ branch: "kstack/top", sha: fakeTop },
		],
		deps: {
			exec,
			realpath: (path) =>
				path === "/repo-link" || path === "/repo with space\nand newline" ? "/canonical/repo" : path,
		},
	});
}

describe("rebase scope inventory failures", () => {
	it("canonicalizes a NUL-delimited initiating worktree path", async () => {
		const inspected = await inspectFakeScope();
		assert.equal(inspected.ok, true);
		if (inspected.ok) assert.equal(inspected.value.initiatingWorktree, "/canonical/repo");
	});

	it("accepts locked, prunable, detached, and bare worktree records", async () => {
		const topPath = "/repo with space\nand newline";
		const topFields = `worktree ${topPath}\0HEAD ${fakeTop}\0branch refs/heads/kstack/top\0`;
		const inventories = new Map<string, string>([
			["locked", `${topFields}locked maintenance\0\0`],
			["prunable", `${topFields}prunable gitdir file points to non-existent location\0\0`],
			["detached", `worktree /detached\0HEAD ${fakeFrontier}\0detached\0\0${fakeWorktree()}`],
			["bare", `worktree /bare.git\0bare\0\0${fakeWorktree()}`],
		]);
		for (const [kind, stdout] of inventories) {
			const inspected = await inspectFakeScope(fakeScopeExec({ [worktreesCommand]: { stdout } }));
			assert.equal(inspected.ok, true, `${kind} worktree record should be accepted`);
		}
	});

	it("refuses failed, empty, or malformed branch inventory", async () => {
		for (const response of [
			{ code: 1, stderr: "cancelled" },
			{ stdout: "" },
			{ stdout: `refs/heads/kstack/top ${fakeTop}\n` },
		]) {
			const inspected = await inspectFakeScope(fakeScopeExec({ [refsCommand]: response }));
			assert.equal(inspected.ok, false);
			if (!inspected.ok) assert.match(inspected.error, /inventory|record/i);
		}
	});

	it("refuses failed, empty, or malformed worktree inventory", async () => {
		for (const response of [
			{ code: 1, stderr: "cancelled" },
			{ stdout: "" },
			{ stdout: `worktree /repo\0HEAD ${fakeTop}\0branch refs/heads/kstack/top\0` },
		]) {
			const inspected = await inspectFakeScope(fakeScopeExec({ [worktreesCommand]: response }));
			assert.equal(inspected.ok, false);
			if (!inspected.ok) assert.match(inspected.error, /worktree/i);
		}
	});

	it("refuses failed or malformed range inspection", async () => {
		const failed = await inspectFakeScope(
			fakeScopeExec({
				[`git rev-list --reverse ${fakeFrontier}..${fakeTop}`]: { code: 1, stderr: "bad object" },
			}),
		);
		assert.equal(failed.ok, false);
		if (!failed.ok) assert.match(failed.error, /Could not inspect.*range/);

		const malformed = await inspectFakeScope(
			fakeScopeExec({
				[`git rev-list --reverse ${fakeFrontier}..${fakeTop}`]: { stdout: `${fakeMiddle}\nnot-a-sha\n` },
			}),
		);
		assert.equal(malformed.ok, false);
		if (!malformed.ok) assert.match(malformed.error, /invalid or incomplete.*range/);
	});

	it("rejects stale top and intermediate ancestry after rebase", async () => {
		const inspected = await inspectFakeScope();
		assert.equal(inspected.ok, true);
		if (!inspected.ok) return;
		const canonicalize = (path: string) =>
			path === "/repo-link" || path === "/repo with space\nand newline" ? "/canonical/repo" : path;
		const staleTop = await verifyRebasedScope({
			cwd: "/repo-link",
			refreshedTrunkSha: fakeTrunk,
			before: inspected.value,
			deps: {
				exec: fakeScopeExec({
					[`git merge-base --is-ancestor ${fakeTrunk} ${fakeTop}`]: { code: 1 },
				}),
				realpath: canonicalize,
			},
		});
		assert.equal(staleTop.ok, false);
		if (!staleTop.ok) assert.match(staleTop.error, /top branch kstack\/top does not descend from refreshed trunk/);

		const staleMiddle = await verifyRebasedScope({
			cwd: "/repo-link",
			refreshedTrunkSha: fakeTrunk,
			before: inspected.value,
			deps: {
				exec: fakeScopeExec({
					[`git rev-list --reverse ${fakeTrunk}..${fakeTop}`]: { stdout: `${fakeTop}\n` },
				}),
				realpath: canonicalize,
			},
		});
		assert.equal(staleMiddle.ok, false);
		if (!staleMiddle.ok) assert.match(staleMiddle.error, /kstack\/middle does not descend from refreshed trunk/);
	});
});

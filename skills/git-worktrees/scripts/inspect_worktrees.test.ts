import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	accessSync,
	chmodSync,
	constants,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createVcsTestEnv } from "../../../extensions/shared/vcs-test-env.ts";
import { encodeInspectionOutput, OUTPUT_CAP, parseWorktreePorcelainZ } from "./inspect_worktrees.ts";

const INSPECTOR = fileURLToPath(new URL("./inspect_worktrees.ts", import.meta.url));
const PLANNER = fileURLToPath(new URL("./plan_worktree.ts", import.meta.url));

interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface InspectionPayload {
	candidate_count: number;
	truncated: boolean;
	worktrees: Array<{
		path: string;
		branch: string | null;
		detached: boolean;
		head: string;
		dirty: boolean;
		status_entries: number;
		untracked_entries: number;
		locked: string | boolean;
		prunable: string | boolean;
		base_ref: string | null;
		base_sha: string | null;
		head_reachable_from_base: boolean | null;
	}>;
	orphans: Array<{ path: string; reason: string }>;
}

interface ManagedWorktreeFixture {
	branch: string;
	path: string;
}

function runNode(script: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CliResult> {
	return new Promise((resolve) => {
		const child = spawn("node", [script, ...args], {
			env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("close", (code) => {
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
}

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<CliResult> {
	return new Promise((resolve, reject) => {
		const child = spawn("git", args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
}

async function initRepo(root: string, branch = "main", env?: NodeJS.ProcessEnv): Promise<string> {
	const repo = join(root, "repo");
	mkdirSync(repo);
	assert.equal((await git(repo, ["init", "-q"], env)).code, 0);
	assert.equal((await git(repo, ["config", "user.name", "Test"], env)).code, 0);
	assert.equal((await git(repo, ["config", "user.email", "test@example.com"], env)).code, 0);
	writeFileSync(join(repo, "file.txt"), "base\n");
	assert.equal((await git(repo, ["add", "file.txt"], env)).code, 0);
	assert.equal((await git(repo, ["commit", "-qm", "init"], env)).code, 0);
	assert.equal((await git(repo, ["branch", "-M", branch], env)).code, 0);
	return repo;
}

function parseInspection(result: CliResult): InspectionPayload {
	assert.equal(result.code, 0, result.stderr);
	// SAFETY: The test controls the CLI JSON and consumes only the declared inspection contract.
	return JSON.parse(result.stdout) as InspectionPayload;
}

function onlyOrphan(payload: InspectionPayload, message?: string): InspectionPayload["orphans"][number] {
	assert.equal(payload.orphans.length, 1, message);
	const orphan = payload.orphans[0];
	assert.ok(orphan, message);
	return orphan;
}

async function addManagedWorktree(
	repo: string,
	managed: string,
	task: string,
	env: NodeJS.ProcessEnv,
): Promise<ManagedWorktreeFixture> {
	const planned = await runNode(PLANNER, ["--repo", repo, "--root", managed, "--task", task], env);
	assert.equal(planned.code, 0, planned.stderr);
	// SAFETY: The test controls the planner JSON and consumes only its declared output contract.
	const plan = JSON.parse(planned.stdout) as ManagedWorktreeFixture;
	mkdirSync(dirname(plan.path), { recursive: true });
	assert.equal((await git(repo, ["worktree", "add", "-q", "-b", plan.branch, plan.path, "HEAD"], env)).code, 0);
	return { ...plan, path: realpathSync(plan.path) };
}

function findExecutable(name: string, env: NodeJS.ProcessEnv): string {
	for (const directory of (env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory, name);
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			// Keep searching PATH.
		}
	}
	throw new Error(`could not find ${name} on PATH`);
}

function createGitWrapperEnv(
	root: string,
	baseEnv: NodeJS.ProcessEnv,
	overrides: Record<string, string>,
): NodeJS.ProcessEnv {
	const wrapperDir = join(root, "git-wrapper");
	const wrapper = join(wrapperDir, "git");
	mkdirSync(wrapperDir, { recursive: true });
	writeFileSync(
		wrapper,
		`#!/bin/sh
if [ -n "$KSTACK_INSPECT_TEST_TARGET" ] && [ "$PWD" != "$KSTACK_INSPECT_TEST_TARGET" ]; then
	exec "$KSTACK_INSPECT_TEST_REAL_GIT" "$@"
fi

if [ "$1" = "status" ]; then
	case "$KSTACK_INSPECT_TEST_STATUS" in
		empty)
			printf '%s' "$KSTACK_INSPECT_TEST_DIAGNOSTIC" >&2
			exit 128
			;;
		misleading)
			printf '?? misleading.txt\\000'
			printf '%s' "$KSTACK_INSPECT_TEST_DIAGNOSTIC" >&2
			exit 128
			;;
	esac
fi

if [ "$1" = "worktree" ] && [ "$2" = "list" ]; then
	case "$KSTACK_INSPECT_TEST_LISTING" in
		empty)
			printf '%s' "$KSTACK_INSPECT_TEST_DIAGNOSTIC" >&2
			exit 128
			;;
		misleading)
			printf 'worktree %s\\000HEAD 0000000000000000000000000000000000000000\\000branch refs/heads/kstack/fake\\000\\000' "$PWD"
			printf '%s' "$KSTACK_INSPECT_TEST_DIAGNOSTIC" >&2
			exit 128
			;;
		missing)
			printf 'worktree %s\\000HEAD 0000000000000000000000000000000000000000\\000branch refs/heads/main\\000\\000' "$KSTACK_INSPECT_TEST_OTHER_WORKTREE"
			exit 0
			;;
		ambiguous)
			printf 'worktree %s\\000HEAD 0000000000000000000000000000000000000000\\000branch refs/heads/kstack/fake\\000\\000' "$PWD"
			printf 'worktree %s\\000HEAD 0000000000000000000000000000000000000000\\000branch refs/heads/kstack/fake\\000\\000' "$PWD"
			exit 0
			;;
		prunable)
			printf 'worktree %s\\000HEAD 0000000000000000000000000000000000000000\\000branch refs/heads/kstack/fake\\000prunable fixture reason\\000\\000' "$PWD"
			exit 0
			;;
	esac
fi

if [ "$1" = "rev-parse" ] && [ "$2" = "--path-format=absolute" ] && [ "$3" = "--git-common-dir" ]; then
	case "$KSTACK_INSPECT_TEST_COMMON" in
		empty)
			exit 0
			;;
		fail)
			printf '%s' "$KSTACK_INSPECT_TEST_DIAGNOSTIC" >&2
			exit 128
			;;
	esac
fi

if [ "$1" = "rev-parse" ] && [ "$2" = "--verify" ] && [ "$3" = "HEAD" ] && [ "$#" -eq 3 ]; then
	case "$KSTACK_INSPECT_TEST_HEAD" in
		empty)
			exit 0
			;;
		fail)
			printf '%s' "$KSTACK_INSPECT_TEST_DIAGNOSTIC" >&2
			exit 128
			;;
	esac
fi

if [ "$1" = "symbolic-ref" ] && [ "$2" = "--quiet" ] && [ "$3" = "--short" ] && [ "$4" = "HEAD" ]; then
	if [ "$KSTACK_INSPECT_TEST_BRANCH" = "fail" ]; then
		printf '%s' "$KSTACK_INSPECT_TEST_DIAGNOSTIC" >&2
		exit 128
	fi
fi

if [ "$1" = "merge-base" ] && [ "$2" = "--is-ancestor" ] && [ "$KSTACK_INSPECT_TEST_MERGE_BASE" = "fail" ]; then
	printf '%s' "$KSTACK_INSPECT_TEST_DIAGNOSTIC" >&2
	exit 128
fi

if [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ] && [ "$KSTACK_INSPECT_TEST_REMOVE_AFTER_TOPLEVEL" = "1" ]; then
	output=$("$KSTACK_INSPECT_TEST_REAL_GIT" "$@")
	code=$?
	rm -rf -- "$PWD"
	printf '%s\\n' "$output"
	exit "$code"
fi

exec "$KSTACK_INSPECT_TEST_REAL_GIT" "$@"
`,
	);
	chmodSync(wrapper, 0o755);
	const env: NodeJS.ProcessEnv = { ...baseEnv };
	for (const key of Object.keys(env)) {
		if (key.startsWith("KSTACK_INSPECT_TEST_")) delete env[key];
	}
	return {
		...env,
		...overrides,
		KSTACK_INSPECT_TEST_REAL_GIT: findExecutable("git", baseEnv),
		PATH: `${wrapperDir}${delimiter}${env.PATH ?? ""}`,
	};
}

describe("parseWorktreePorcelainZ", () => {
	it("parses a synthetic NUL record", () => {
		const data = Buffer.from(
			"worktree /repo\0HEAD abc\0branch refs/heads/main\0\0worktree /managed/x\0HEAD def\0branch refs/heads/kstack/x\0locked build\0\0",
		);
		assert.deepEqual(parseWorktreePorcelainZ(data), [
			{ worktree: "/repo", HEAD: "abc", branch: "refs/heads/main" },
			{ worktree: "/managed/x", HEAD: "def", branch: "refs/heads/kstack/x", locked: "build" },
		]);
	});
});

describe("inspect_worktrees CLI", () => {
	it("rejects out-of-range --max and --timeout", async () => {
		const max = await runNode(INSPECTOR, ["--max", "0"]);
		assert.equal(max.code, 2);
		assert.deepEqual(JSON.parse(max.stdout), { error: "--max must be between 1 and 1000" });
		const timeout = await runNode(INSPECTOR, ["--timeout", "61"]);
		assert.equal(timeout.code, 2);
		assert.deepEqual(JSON.parse(timeout.stdout), { error: "--timeout must be between 1 and 60" });
	});

	it("marks a symlink as an orphan without following it", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-inspect-"));
		const vcsEnv = createVcsTestEnv(root);
		try {
			const managed = join(root, "managed");
			const namespace = join(managed, "repo-12345678");
			const outside = join(root, "outside");
			mkdirSync(namespace, { recursive: true });
			mkdirSync(outside);
			symlinkSync(outside, join(namespace, "escape"));
			const result = await runNode(INSPECTOR, ["--root", managed], vcsEnv);
			assert.equal(result.code, 0, result.stderr);
			// SAFETY: The test controls the CLI JSON and asserts the declared output contract immediately below.
			const payload = JSON.parse(result.stdout) as {
				worktrees: unknown[];
				orphans: Array<{ reason: string }>;
			};
			assert.deepEqual(payload.worktrees, []);
			assert.match(payload.orphans[0]?.reason ?? "", /symlink/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("truncates listing at --max", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-inspect-"));
		const vcsEnv = createVcsTestEnv(root);
		try {
			const managed = join(root, "managed");
			const namespace = join(managed, "repo-12345678");
			mkdirSync(join(namespace, "one"), { recursive: true });
			mkdirSync(join(namespace, "two"));
			const result = await runNode(INSPECTOR, ["--root", managed, "--max", "1"], vcsEnv);
			assert.equal(result.code, 0, result.stderr);
			// SAFETY: The test controls the CLI JSON and asserts the declared output contract immediately below.
			const payload = JSON.parse(result.stdout) as {
				candidate_count: number;
				truncated: boolean;
				orphans: unknown[];
				worktrees: unknown[];
			};
			assert.equal(payload.candidate_count, 2);
			assert.equal(payload.truncated, true);
			assert.equal(payload.orphans.length + payload.worktrees.length, 1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("caps oversized output", () => {
		const encoded = encodeInspectionOutput({
			managed_root: "/managed",
			worktrees: [{ path: "x".repeat(OUTPUT_CAP) }],
			orphans: [],
			truncated: false,
			candidate_count: 1,
		});
		assert.equal(encoded.overflow, true);
		// SAFETY: The test controls the CLI JSON and asserts the declared output contract immediately below.
		const payload = JSON.parse(encoded.body) as {
			error: string;
			truncated: boolean;
			candidate_count: number;
			managed_root: string;
		};
		assert.match(payload.error, /exceeded/);
		assert.equal(payload.truncated, true);
		assert.equal(payload.candidate_count, 1);
		assert.equal(payload.managed_root, "/managed");
	});

	it("inspects a dirty and locked managed worktree", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-inspect-"));
		const vcsEnv = createVcsTestEnv(root);
		try {
			const repo = await initRepo(root, "main", vcsEnv);
			const managed = join(root, "managed");
			const candidate = await addManagedWorktree(repo, managed, "change", vcsEnv);
			writeFileSync(join(candidate.path, "new.txt"), "untracked\n");
			assert.equal((await git(repo, ["worktree", "lock", "--reason", "fixture", candidate.path], vcsEnv)).code, 0);
			const payload = parseInspection(await runNode(INSPECTOR, ["--root", managed], vcsEnv));
			assert.deepEqual(payload.orphans, []);
			assert.equal(payload.worktrees.length, 1);
			assert.equal(payload.worktrees[0]?.branch, candidate.branch);
			assert.equal(payload.worktrees[0]?.dirty, true);
			assert.equal(payload.worktrees[0]?.untracked_entries, 1);
			assert.equal(payload.worktrees[0]?.locked, "fixture");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses resolveIsolationBase when a worktree has no remote", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-inspect-"));
		const vcsEnv = createVcsTestEnv(root);
		try {
			const repo = await initRepo(root, "topic", vcsEnv);
			const managed = join(root, "managed");
			const planned = await runNode(PLANNER, ["--repo", repo, "--root", managed, "--task", "change"], vcsEnv);
			assert.equal(planned.code, 0, planned.stderr);
			// SAFETY: The test controls the CLI JSON and asserts the declared output contract immediately below.
			const plan = JSON.parse(planned.stdout) as { path: string; base_ref: string };
			assert.equal(plan.base_ref, "HEAD");
			mkdirSync(dirname(plan.path), { recursive: true });
			assert.equal(
				(await git(repo, ["worktree", "add", "-q", "-b", "kstack/change", plan.path, "HEAD"], vcsEnv)).code,
				0,
			);
			const result = await runNode(INSPECTOR, ["--root", managed], vcsEnv);
			assert.equal(result.code, 0, result.stderr);
			// SAFETY: The test controls the CLI JSON and asserts the declared output contract immediately below.
			const payload = JSON.parse(result.stdout) as {
				worktrees: Array<{ base_ref: string; base_sha: string }>;
			};
			assert.equal(payload.worktrees[0]?.base_ref, "HEAD");
			assert.equal(payload.worktrees[0]?.base_sha.length, 40);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports status and listing inspection failures instead of false clean rows", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-inspect-"));
		const vcsEnv = createVcsTestEnv(root);
		try {
			const repo = await initRepo(root, "main", vcsEnv);
			const managed = join(root, "managed");
			const candidate = await addManagedWorktree(repo, managed, "failed-facts", vcsEnv);
			writeFileSync(join(candidate.path, "dirty.txt"), "untracked\n");
			const cases: Array<{ label: string; overrides: Record<string, string>; command: RegExp }> = [
				{
					label: "status with empty stdout",
					overrides: { KSTACK_INSPECT_TEST_STATUS: "empty" },
					command: /git status/,
				},
				{
					label: "status with misleading stdout",
					overrides: { KSTACK_INSPECT_TEST_STATUS: "misleading" },
					command: /git status/,
				},
				{
					label: "listing with misleading stdout",
					overrides: { KSTACK_INSPECT_TEST_LISTING: "misleading" },
					command: /git worktree list/,
				},
				{
					label: "status and listing together",
					overrides: {
						KSTACK_INSPECT_TEST_STATUS: "empty",
						KSTACK_INSPECT_TEST_LISTING: "empty",
					},
					command: /git status/,
				},
			];
			for (const testCase of cases) {
				const env = createGitWrapperEnv(root, vcsEnv, {
					...testCase.overrides,
					KSTACK_INSPECT_TEST_TARGET: candidate.path,
					KSTACK_INSPECT_TEST_DIAGNOSTIC: "forced fixture failure",
				});
				const payload = parseInspection(await runNode(INSPECTOR, ["--root", managed], env));
				assert.deepEqual(payload.worktrees, [], testCase.label);
				const orphan = onlyOrphan(payload, testCase.label);
				assert.match(orphan.reason, /^inspection failed:/, testCase.label);
				assert.match(orphan.reason, testCase.command, testCase.label);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports missing and ambiguous authoritative listing matches as inspection failures", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-inspect-"));
		const vcsEnv = createVcsTestEnv(root);
		try {
			const repo = await initRepo(root, "main", vcsEnv);
			const managed = join(root, "managed");
			const candidate = await addManagedWorktree(repo, managed, "listing", vcsEnv);
			for (const mode of ["missing", "ambiguous"]) {
				const env = createGitWrapperEnv(root, vcsEnv, {
					KSTACK_INSPECT_TEST_TARGET: candidate.path,
					KSTACK_INSPECT_TEST_LISTING: mode,
					KSTACK_INSPECT_TEST_OTHER_WORKTREE: repo,
				});
				const payload = parseInspection(await runNode(INSPECTOR, ["--root", managed], env));
				assert.deepEqual(payload.worktrees, [], mode);
				const orphan = onlyOrphan(payload, mode);
				assert.match(orphan.reason, /^inspection failed:.*worktree list/, mode);
				assert.match(orphan.reason, new RegExp(mode), mode);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a nested candidate whose Git toplevel is its parent", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-inspect-"));
		const vcsEnv = createVcsTestEnv(root);
		try {
			const managed = join(root, "managed");
			const repository = join(managed, "repo-12345678");
			const candidate = join(repository, "nested");
			mkdirSync(candidate, { recursive: true });
			assert.equal(
				(await git(repository, ["init", "-q", "--separate-git-dir", join(root, "separate-git-dir")], vcsEnv)).code,
				0,
			);
			writeFileSync(join(repository, "file.txt"), "base\n");
			assert.equal((await git(repository, ["add", "file.txt"], vcsEnv)).code, 0);
			assert.equal((await git(repository, ["commit", "-qm", "init"], vcsEnv)).code, 0);
			const payload = parseInspection(await runNode(INSPECTOR, ["--root", managed], vcsEnv));
			assert.deepEqual(payload.worktrees, []);
			const orphan = onlyOrphan(payload);
			assert.equal(orphan.path, realpathSync(candidate));
			assert.match(orphan.reason, /^inspection failed:.*toplevel.*candidate/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports unavailable common-directory, HEAD, and branch facts as inspection failures", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-inspect-"));
		const vcsEnv = createVcsTestEnv(root);
		try {
			const repo = await initRepo(root, "main", vcsEnv);
			const managed = join(root, "managed");
			const candidate = await addManagedWorktree(repo, managed, "facts", vcsEnv);
			const cases = [
				{
					label: "failed common directory",
					key: "KSTACK_INSPECT_TEST_COMMON",
					value: "fail",
					command: /git-common-dir/,
				},
				{
					label: "empty common directory",
					key: "KSTACK_INSPECT_TEST_COMMON",
					value: "empty",
					command: /git-common-dir/,
				},
				{ label: "failed HEAD", key: "KSTACK_INSPECT_TEST_HEAD", value: "fail", command: /rev-parse --verify HEAD/ },
				{ label: "empty HEAD", key: "KSTACK_INSPECT_TEST_HEAD", value: "empty", command: /rev-parse --verify HEAD/ },
				{ label: "failed branch", key: "KSTACK_INSPECT_TEST_BRANCH", value: "fail", command: /symbolic-ref/ },
			];
			for (const testCase of cases) {
				const env = createGitWrapperEnv(root, vcsEnv, {
					KSTACK_INSPECT_TEST_TARGET: candidate.path,
					KSTACK_INSPECT_TEST_DIAGNOSTIC: "forced fixture failure",
					[testCase.key]: testCase.value,
				});
				const payload = parseInspection(await runNode(INSPECTOR, ["--root", managed], env));
				assert.deepEqual(payload.worktrees, [], testCase.label);
				const orphan = onlyOrphan(payload, testCase.label);
				assert.match(orphan.reason, /^inspection failed:/, testCase.label);
				assert.match(orphan.reason, testCase.command, testCase.label);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("treats only merge-base exits 0 and 1 as classifications", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-inspect-"));
		const vcsEnv = createVcsTestEnv(root);
		try {
			const repo = await initRepo(root, "main", vcsEnv);
			const managed = join(root, "managed");
			const candidate = await addManagedWorktree(repo, managed, "reachability", vcsEnv);
			let payload = parseInspection(await runNode(INSPECTOR, ["--root", managed], vcsEnv));
			assert.equal(payload.worktrees[0]?.head_reachable_from_base, true);

			writeFileSync(join(candidate.path, "commit.txt"), "topic\n");
			assert.equal((await git(candidate.path, ["add", "commit.txt"], vcsEnv)).code, 0);
			assert.equal((await git(candidate.path, ["commit", "-qm", "topic"], vcsEnv)).code, 0);
			payload = parseInspection(await runNode(INSPECTOR, ["--root", managed], vcsEnv));
			assert.equal(payload.worktrees[0]?.head_reachable_from_base, false);

			const failingEnv = createGitWrapperEnv(root, vcsEnv, {
				KSTACK_INSPECT_TEST_TARGET: candidate.path,
				KSTACK_INSPECT_TEST_MERGE_BASE: "fail",
				KSTACK_INSPECT_TEST_DIAGNOSTIC: "forced fixture failure",
			});
			payload = parseInspection(await runNode(INSPECTOR, ["--root", managed], failingEnv));
			assert.deepEqual(payload.worktrees, []);
			assert.match(onlyOrphan(payload).reason, /^inspection failed:.*merge-base/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves legitimate detached HEAD and prunable classifications", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-inspect-"));
		const vcsEnv = createVcsTestEnv(root);
		try {
			const repo = await initRepo(root, "main", vcsEnv);
			const managed = join(root, "managed");
			const candidate = await addManagedWorktree(repo, managed, "detached", vcsEnv);
			assert.equal((await git(candidate.path, ["checkout", "--detach", "-q"], vcsEnv)).code, 0);
			let payload = parseInspection(await runNode(INSPECTOR, ["--root", managed], vcsEnv));
			assert.equal(payload.worktrees[0]?.branch, null);
			assert.equal(payload.worktrees[0]?.detached, true);
			assert.match(payload.worktrees[0]?.head ?? "", /^[0-9a-f]{40,64}$/);

			const prunableEnv = createGitWrapperEnv(root, vcsEnv, {
				KSTACK_INSPECT_TEST_TARGET: candidate.path,
				KSTACK_INSPECT_TEST_LISTING: "prunable",
			});
			payload = parseInspection(await runNode(INSPECTOR, ["--root", managed], prunableEnv));
			assert.equal(payload.worktrees[0]?.prunable, "fixture reason");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps valid siblings when one candidate has an inspection failure", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-inspect-"));
		const vcsEnv = createVcsTestEnv(root);
		try {
			const repo = await initRepo(root, "main", vcsEnv);
			const managed = join(root, "managed");
			const failed = await addManagedWorktree(repo, managed, "failed", vcsEnv);
			const valid = await addManagedWorktree(repo, managed, "valid", vcsEnv);
			const env = createGitWrapperEnv(root, vcsEnv, {
				KSTACK_INSPECT_TEST_TARGET: failed.path,
				KSTACK_INSPECT_TEST_STATUS: "empty",
			});
			const payload = parseInspection(await runNode(INSPECTOR, ["--root", managed], env));
			assert.deepEqual(
				payload.worktrees.map((worktree) => worktree.path),
				[valid.path],
			);
			assert.deepEqual(
				payload.orphans.map((orphan) => orphan.path),
				[failed.path],
			);
			assert.match(onlyOrphan(payload).reason, /^inspection failed:.*git status/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports a candidate that vanishes during inspection", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-inspect-"));
		const vcsEnv = createVcsTestEnv(root);
		try {
			const repo = await initRepo(root, "main", vcsEnv);
			const managed = join(root, "managed");
			const candidate = await addManagedWorktree(repo, managed, "vanished", vcsEnv);
			const env = createGitWrapperEnv(root, vcsEnv, {
				KSTACK_INSPECT_TEST_TARGET: candidate.path,
				KSTACK_INSPECT_TEST_REMOVE_AFTER_TOPLEVEL: "1",
			});
			const payload = parseInspection(await runNode(INSPECTOR, ["--root", managed], env));
			assert.deepEqual(payload.worktrees, []);
			const orphan = onlyOrphan(payload);
			assert.equal(orphan.path, candidate.path);
			assert.match(orphan.reason, /^inspection failed:/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("bounds inspection failure diagnostics", async () => {
		const root = mkdtempSync(join(tmpdir(), "kstack-inspect-"));
		const vcsEnv = createVcsTestEnv(root);
		try {
			const repo = await initRepo(root, "main", vcsEnv);
			const managed = join(root, "managed");
			const candidate = await addManagedWorktree(repo, managed, "bounded", vcsEnv);
			const env = createGitWrapperEnv(root, vcsEnv, {
				KSTACK_INSPECT_TEST_TARGET: candidate.path,
				KSTACK_INSPECT_TEST_STATUS: "empty",
				KSTACK_INSPECT_TEST_DIAGNOSTIC: "x".repeat(4096),
			});
			const payload = parseInspection(await runNode(INSPECTOR, ["--root", managed], env));
			assert.deepEqual(payload.worktrees, []);
			const orphan = onlyOrphan(payload);
			assert.ok(orphan.reason.length <= 512);
			assert.match(orphan.reason, /^inspection failed:.*git status/);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

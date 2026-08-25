import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecFn } from "../git-exec.ts";
import { GraphiteBackend } from "./graphite-backend.ts";

const sha = "a".repeat(40);

function scripted(responses: Record<string, { code?: number; stdout?: string; stderr?: string }>) {
	const calls: string[] = [];
	const exec: ExecFn = async (command, args) => {
		const key = `${command} ${args.join(" ")}`;
		calls.push(key);
		const result = responses[key] ?? {};
		return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	};
	return { exec, calls };
}

function publicationDeps(onRelease: () => void = () => {}) {
	return {
		realpath: (path: string) => path,
		acquireLock: () => ({
			ok: true as const,
			lock: {
				release: () => {
					onRelease();
					return { ok: true as const };
				},
			},
		}),
	};
}

describe("GraphiteBackend", () => {
	it("creates a collision-safe workstream with native gt", async () => {
		const { exec, calls } = scripted({
			"git status --porcelain=v1 --untracked-files=all": {},
			"git rev-parse HEAD": { stdout: `${sha}\n` },
			"git show-ref --verify --quiet refs/heads/kstack/fix-search": { code: 1 },
			"git branch --show-current": { stdout: "kstack/fix-search\n" },
		});
		const result = await new GraphiteBackend(exec).createWorkstream("/repo", "Fix search");
		assert.deepEqual(result, { ok: true, ref: "kstack/fix-search", baseSha: sha });
		assert.ok(calls.includes("gt --no-interactive --no-ai create kstack/fix-search --message Fix search"));
		assert.equal(
			calls.some((call) => call.startsWith("git switch")),
			false,
		);
	});

	it("records and publishes through native Graphite commands", async () => {
		const nextSha = "b".repeat(40);
		let headReads = 0;
		const { exec, calls } = scripted({
			"git branch --show-current": { stdout: "kstack/fix\n" },
			"git rev-parse --path-format=absolute --git-common-dir": { stdout: "/repo/.git\n" },
			"gt --no-interactive --no-ai submit --no-stack --draft --no-edit --dry-run": {
				stdout: "Preparing to submit PRs for the following branches...\n▸ kstack/fix (Create)\n✅ Dry run complete.\n",
			},
			"git fetch origin kstack/fix": {},
			"git rev-parse origin/kstack/fix": { stdout: `${nextSha}\n` },
		});
		const wrapped: ExecFn = async (command, args, options) => {
			if (command === "git" && args.join(" ") === "rev-parse HEAD") {
				return { code: 0, stdout: `${headReads++ === 0 ? sha : nextSha}\n`, stderr: "" };
			}
			return exec(command, args, options);
		};
		const backend = new GraphiteBackend(wrapped, publicationDeps());
		assert.deepEqual(await backend.recordPaths("/repo", ["src/file.ts"], "Record change"), { ok: true });
		assert.deepEqual(await backend.publishRecordedChanges("/repo", "kstack/fix"), { ok: true });
		assert.ok(calls.includes("gt --no-interactive add -- src/file.ts"));
		assert.ok(calls.includes("gt --no-interactive --no-ai modify --commit --message Record change"));
		assert.ok(calls.includes("gt --no-interactive --no-ai submit --no-stack --draft --no-edit --dry-run"));
		assert.ok(calls.includes("gt --no-interactive --no-ai submit --no-stack --draft --no-edit"));
		assert.equal(
			calls.some((call) => call.startsWith("git commit") || call.startsWith("git push")),
			false,
		);
	});

	it("uses update-only Graphite submission for an existing autopilot PR", async () => {
		const { exec, calls } = scripted({
			"git branch --show-current": { stdout: "kstack/fix\n" },
			"git rev-parse --path-format=absolute --git-common-dir": { stdout: "/repo/.git\n" },
			"gt --no-interactive --no-ai submit --no-stack --draft --no-edit --update-only --dry-run": {
				stdout: "Preparing to submit PRs for the following branches...\n▸ kstack/fix (Update)\n✅ Dry run complete.\n",
			},
			"git rev-parse HEAD": { stdout: `${sha}\n` },
			"git fetch origin kstack/fix": {},
			"git rev-parse origin/kstack/fix": { stdout: `${sha}\n` },
		});
		assert.deepEqual(
			await new GraphiteBackend(exec, publicationDeps()).publishRecordedChanges("/repo", "kstack/fix", {
				existingOnly: true,
			}),
			{ ok: true },
		);
		assert.ok(
			calls.includes("gt --no-interactive --no-ai submit --no-stack --draft --no-edit --update-only --dry-run"),
		);
		assert.ok(calls.includes("gt --no-interactive --no-ai submit --no-stack --draft --no-edit --update-only"));
	});

	it("restacks through Graphite and reports whether HEAD changed", async () => {
		let head = sha;
		const { exec, calls } = scripted({});
		const wrapped: ExecFn = async (command, args, options) => {
			if (command === "git" && args.join(" ") === "rev-parse HEAD") return { code: 0, stdout: `${head}\n`, stderr: "" };
			if (command === "gt" && args.includes("restack")) head = "b".repeat(40);
			return exec(command, args, options);
		};
		assert.deepEqual(await new GraphiteBackend(wrapped).updateBase("/repo", "main"), {
			kind: "clean",
			headSha: "b".repeat(40),
		});
		assert.ok(calls.includes("gt --no-interactive get main --downstack --no-checkout --no-restack"));
		assert.ok(calls.includes("gt --no-interactive restack --only"));
	});

	it("reconciles a nonzero submit when the exact remote head was published", async () => {
		let released = false;
		const { exec } = scripted({
			"git branch --show-current": { stdout: "kstack/fix\n" },
			"git rev-parse HEAD": { stdout: `${sha}\n` },
			"git rev-parse --path-format=absolute --git-common-dir": { stdout: "/repo/.git\n" },
			"gt --no-interactive --no-ai submit --no-stack --draft --no-edit --update-only --dry-run": {
				stdout: "Preparing to submit PRs for the following branches...\n▸ kstack/fix (Update)\n✅ Dry run complete.\n",
			},
			"gt --no-interactive --no-ai submit --no-stack --draft --no-edit --update-only": {
				code: 1,
				stderr: "connection lost",
			},
			"git fetch origin kstack/fix": {},
			"git rev-parse origin/kstack/fix": { stdout: `${sha}\n` },
		});
		const result = await new GraphiteBackend(exec, {
			realpath: (path) => path,
			acquireLock: () => ({
				ok: true,
				lock: {
					release: () => {
						released = true;
						return { ok: true };
					},
				},
			}),
		}).publishRecordedChanges("/repo", "kstack/fix", { existingOnly: true });
		assert.deepEqual(result, { ok: true });
		assert.equal(released, true);
	});

	it("reports an indeterminate submit when remote reconciliation fails", async () => {
		const { exec } = scripted({
			"git branch --show-current": { stdout: "kstack/fix\n" },
			"git rev-parse HEAD": { stdout: `${sha}\n` },
			"git rev-parse --path-format=absolute --git-common-dir": { stdout: "/repo/.git\n" },
			"gt --no-interactive --no-ai submit --no-stack --draft --no-edit --dry-run": {
				stdout: "Preparing to submit PRs for the following branches...\n▸ kstack/fix (Update)\n✅ Dry run complete.\n",
			},
			"gt --no-interactive --no-ai submit --no-stack --draft --no-edit": {
				code: 1,
				stderr: "connection lost",
			},
			"git fetch origin kstack/fix": { code: 1, stderr: "offline" },
		});
		const result = await new GraphiteBackend(exec, publicationDeps()).publishRecordedChanges("/repo", "kstack/fix");
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /may have started/);
		assert.match(result.ok ? "" : result.error, /do not retry/i);
	});

	it("fails closed when an autopilot rewrite could affect descendants", async () => {
		const { exec, calls } = scripted({
			"git branch --show-current": { stdout: "kstack/fix\n" },
			"gt --no-interactive children": { stdout: "kstack/child\n" },
		});
		const result = await new GraphiteBackend(exec).rewriteScope.assertSingleRef("/repo", "kstack/fix");
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /local descendants/);
		assert.ok(calls.includes("gt --no-interactive children"));
	});

	it("permits a bounded single-ref rewrite when Graphite reports no children", async () => {
		const { exec } = scripted({
			"git branch --show-current": { stdout: "kstack/top\n" },
			"gt --no-interactive children": {},
		});
		assert.deepEqual(await new GraphiteBackend(exec).rewriteScope.assertSingleRef("/repo", "kstack/top"), {
			ok: true,
			affectedRefs: ["kstack/top"],
		});
	});

	it("parses rename records and removes only enumerated untracked paths", async () => {
		const removed: string[] = [];
		const { exec } = scripted({
			"git status --porcelain=v1 -z --untracked-files=all": {
				stdout: "R  new name.ts\0old name.ts\0?? scratch.txt\0",
			},
			"git ls-files --error-unmatch -- scratch.txt": { code: 1 },
		});
		const backend = new GraphiteBackend(exec, { unlink: (path) => removed.push(path) });
		assert.deepEqual(await backend.changedPaths("/repo"), {
			ok: true,
			paths: ["new name.ts", "old name.ts", "scratch.txt"],
		});
		assert.deepEqual(await backend.restorePaths("/repo", ["scratch.txt"]), { ok: true });
		assert.deepEqual(removed, ["/repo/scratch.txt"]);
	});

	it("does not submit when Graphite's dry run includes a downstack branch", async () => {
		const { exec, calls } = scripted({
			"git branch --show-current": { stdout: "kstack/top\n" },
			"git rev-parse HEAD": { stdout: `${sha}\n` },
			"git rev-parse --path-format=absolute --git-common-dir": { stdout: "/repo/.git\n" },
			"gt --no-interactive --no-ai submit --no-stack --draft --no-edit --dry-run": {
				stdout:
					"Preparing to submit PRs for the following branches...\n▸ kstack/base (Update)\n▸ kstack/top (Update)\n✅ Dry run complete.\n",
			},
		});
		const result = await new GraphiteBackend(exec, publicationDeps()).publishRecordedChanges("/repo", "kstack/top");
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /kstack\/base/);
		assert.equal(calls.includes("gt --no-interactive --no-ai submit --no-stack --draft --no-edit"), false);
	});

	it("does not unlink when tracked-state inspection fails", async () => {
		const removed: string[] = [];
		const { exec } = scripted({
			"git ls-files --error-unmatch -- scratch.txt": { code: 128, stderr: "index unavailable" },
		});
		const result = await new GraphiteBackend(exec, { unlink: (path) => removed.push(path) }).restorePaths("/repo", [
			"scratch.txt",
		]);
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /index unavailable/);
		assert.deepEqual(removed, []);
	});

	it("allocates a Git worktree and tracks it with Graphite metadata", async () => {
		const { exec, calls } = scripted({
			"git rev-parse --show-toplevel": { stdout: "/repo\n" },
			"git rev-parse --path-format=absolute --git-common-dir": { stdout: "/repo/.git\n" },
			"git remote": { stdout: "origin\n" },
			"git symbolic-ref --quiet refs/remotes/origin/HEAD": { stdout: "refs/remotes/origin/main\n" },
			"git rev-parse --verify refs/remotes/origin/main^{commit}": { stdout: `${sha}\n` },
			"git show-ref --verify --quiet refs/heads/kstack/fix-search": { code: 1 },
			"gt --no-interactive trunk": { stdout: "main\n" },
			"git rev-parse --verify refs/heads/main^{commit}": { stdout: `${sha}\n` },
			"git branch --show-current": { stdout: "kstack/fix-search\n" },
		});
		const backend = new GraphiteBackend(exec, {
			managedRoot: "/managed",
			exists: () => false,
			realpath: (path) => path,
			mkdir: () => {},
		});
		const planned = await backend.isolation.plan("/repo", "Fix search");
		assert.equal(planned.ok, true);
		if (!planned.ok) return;
		assert.equal(planned.plan.baseRef, "main");
		assert.deepEqual(await backend.isolation.create(planned.plan), { ok: true, plan: planned.plan });
		assert.ok(
			calls.includes(
				`git worktree add --no-guess-remote -b ${planned.plan.ref} ${planned.plan.path} ${planned.plan.baseSha}`,
			),
		);
		assert.ok(calls.includes("gt --no-interactive track kstack/fix-search --parent main"));
	});

	it("preserves dirty managed worktrees during cleanup", async () => {
		const cwd = "/managed/task";
		const { exec, calls } = scripted({
			"git rev-parse --path-format=absolute --git-common-dir": { stdout: "/repo/.git\n" },
			"git worktree list --porcelain -z": {
				stdout: `worktree ${cwd}\0HEAD ${sha}\0branch refs/heads/kstack/task\0\0`,
			},
			"git status --porcelain=v1 --untracked-files=all": { stdout: "?? notes.txt\n" },
		});
		const backend = new GraphiteBackend(exec, { managedRoot: "/managed", realpath: (path) => path });
		assert.deepEqual(await backend.isolation.remove(cwd, "kstack/task"), {
			ok: false,
			error: `Worktree ${cwd} has uncommitted or untracked files; cleanup preserved it.`,
		});
		assert.equal(
			calls.some((call) => call.includes("worktree remove") || call.includes("gt --no-interactive delete")),
			false,
		);
	});
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecFn } from "../shared/git-exec.ts";
import type { GitHubGateway } from "../shared/github.ts";
import { discoverGitHubStack } from "./discovery.ts";

const trunk = "a".repeat(40);
const one = "b".repeat(40);
const two = "c".repeat(40);

function gateway(): Pick<GitHubGateway, "getDefaultBranch"> {
	return { getDefaultBranch: async () => "main" };
}

function scripted(overrides: Record<string, { code?: number; stdout?: string; stderr?: string }> = {}): ExecFn {
	const defaults = {
		"git rev-parse --show-toplevel": { stdout: "/repo\n" },
		"git --version": { stdout: "git version 2.38.0\n" },
		"git remote get-url origin": { stdout: "git@github.com:o/r.git\n" },
		"git symbolic-ref refs/remotes/origin/HEAD": { stdout: "refs/remotes/origin/main\n" },
		"git fetch origin +refs/heads/main:refs/remotes/origin/main": {},
		"git rev-parse --verify refs/remotes/origin/main^{commit}": { stdout: `${trunk}\n` },
		"git rev-parse --verify refs/heads/kstack/two^{commit}": { stdout: `${two}\n` },
		[`git merge-base ${two} ${trunk}`]: { stdout: `${trunk}\n` },
		[`git rev-list --first-parent --reverse ${trunk}..${two}`]: { stdout: `${one}\n${two}\n` },
		[`git rev-list --min-parents=2 ${trunk}..${two}`]: {},
		"git for-each-ref --format=%(refname:short)%09%(objectname) refs/heads": {
			stdout: `main\t${trunk}\nkstack/one\t${one}\nkstack/two\t${two}\n`,
		},
		[`git merge-base --is-ancestor ${one} ${two}`]: {},
		[`git show -s --format=%s ${one}`]: { stdout: "One\n" },
		[`git show -s --format=%s ${two}`]: { stdout: "Two\n" },
	} satisfies Record<string, { code?: number; stdout?: string; stderr?: string }>;
	const defaultResponses = new Map<string, { code?: number; stdout?: string; stderr?: string }>(
		Object.entries(defaults),
	);
	return async (command, args) => {
		const key = `${command} ${args.join(" ")}`;
		const result = overrides[key] ?? defaultResponses.get(key) ?? {};
		return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	};
}

describe("GitHub stack discovery", () => {
	it("derives a linear manifest from owned first-parent branch tips", async () => {
		const result = await discoverGitHubStack({
			cwd: "/repo",
			top: "kstack/two",
			remote: "origin",
			exec: scripted(),
			gateway: gateway(),
		});
		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.deepEqual(
			result.manifest.slices.map((slice) => slice.branch),
			["kstack/one", "kstack/two"],
		);
		assert.equal(result.manifest.slices[0].baseBranch, "refs/remotes/origin/main");
	});

	it("blocks a stack whose merge-base is behind fetched trunk", async () => {
		const oldTrunk = "d".repeat(40);
		const result = await discoverGitHubStack({
			cwd: "/repo",
			top: "kstack/two",
			remote: "origin",
			exec: scripted({
				[`git merge-base ${two} ${trunk}`]: { stdout: `${oldTrunk}\n` },
				[`git rev-list --first-parent --reverse ${oldTrunk}..${two}`]: { stdout: `${one}\n${two}\n` },
				[`git rev-list --min-parents=2 ${oldTrunk}..${two}`]: {},
			}),
			gateway: gateway(),
		});
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /rebase.*latest trunk/i);
	});

	it("blocks a non-owned branch tip inside the selected range", async () => {
		const result = await discoverGitHubStack({
			cwd: "/repo",
			top: "kstack/two",
			remote: "origin",
			exec: scripted({
				"git for-each-ref --format=%(refname:short)%09%(objectname) refs/heads": {
					stdout: `feature\t${one}\nkstack/two\t${two}\n`,
				},
			}),
			gateway: gateway(),
		});
		assert.equal(result.ok, false);
		assert.match(result.ok ? "" : result.error, /Non-kstack branch feature/);
	});

	it("blocks merge commits and empty ancestry", async () => {
		const merge = await discoverGitHubStack({
			cwd: "/repo",
			top: "kstack/two",
			remote: "origin",
			exec: scripted({ [`git rev-list --min-parents=2 ${trunk}..${two}`]: { stdout: `${two}\n` } }),
			gateway: gateway(),
		});
		assert.match(merge.ok ? "" : merge.error, /merge commit/);
		const empty = await discoverGitHubStack({
			cwd: "/repo",
			top: "kstack/two",
			remote: "origin",
			exec: scripted({ [`git rev-list --first-parent --reverse ${trunk}..${two}`]: { stdout: "" } }),
			gateway: gateway(),
		});
		assert.match(empty.ok ? "" : empty.error, /no commits above trunk/);
	});
});

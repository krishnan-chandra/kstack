import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecFn } from "../git-exec.ts";
import { isSafeStackRef, verifyStackManifestGitFacts } from "./manifest.ts";

const manifest = {
	schemaVersion: 1 as const,
	trunkRef: "refs/remotes/origin/main",
	trunkSha: "a".repeat(40),
	slices: [{ branch: "kstack/one", baseBranch: "refs/remotes/origin/main", headSha: "b".repeat(40), subject: "One" }],
};

describe("stack manifest", () => {
	it("validates safe and owned stack refs", () => {
		assert.equal(isSafeStackRef("refs/remotes/origin/main"), true);
		assert.equal(isSafeStackRef("kstack/one", true), true);
		assert.equal(isSafeStackRef("feature", true), false);
		assert.equal(isSafeStackRef("bad..ref"), false);
		assert.equal(isSafeStackRef("bad.lock"), false);
	});

	it("forwards cancellation to every Git verification command", async () => {
		const signal = new AbortController().signal;
		const seenSignals: Array<AbortSignal | undefined> = [];
		const exec: ExecFn = async (command, args, options) => {
			seenSignals.push(options.signal);
			const key = `${command} ${args.join(" ")}`;
			const responses = new Map([
				["git rev-parse --show-toplevel", { code: 0, stdout: "/repo\n", stderr: "" }],
				["git status --porcelain=v1 --untracked-files=all", { code: 0, stdout: "", stderr: "" }],
				["git branch --show-current", { code: 0, stdout: "kstack/one\n", stderr: "" }],
				[
					"git rev-parse --verify refs/remotes/origin/main^{commit}",
					{ code: 0, stdout: `${manifest.trunkSha}\n`, stderr: "" },
				],
				["git check-ref-format --branch kstack/one", { code: 0, stdout: "", stderr: "" }],
				[
					"git rev-parse --verify refs/heads/kstack/one^{commit}",
					{ code: 0, stdout: `${manifest.slices[0].headSha}\n`, stderr: "" },
				],
				[
					`git merge-base --is-ancestor ${manifest.trunkSha} ${manifest.slices[0].headSha}`,
					{ code: 0, stdout: "", stderr: "" },
				],
				[`git diff --quiet ${manifest.trunkSha} ${manifest.slices[0].headSha} --`, { code: 1, stdout: "", stderr: "" }],
			]);
			return responses.get(key) ?? { code: 1, stdout: "", stderr: `unexpected ${key}` };
		};
		const result = await verifyStackManifestGitFacts("/repo", manifest, exec, "GitHub", signal);
		assert.equal(result.ok, true);
		assert.ok(seenSignals.length > 0);
		assert.ok(seenSignals.every((seen) => seen === signal));
	});
});

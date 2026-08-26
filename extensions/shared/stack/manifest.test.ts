import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecFn } from "../git-exec.ts";
import { MAX_STACK_SLICES, parseStackManifest, verifyStackManifestGitFacts } from "./manifest.ts";

const manifest = {
	schemaVersion: 1,
	trunkRef: "refs/remotes/origin/main",
	trunkSha: "a".repeat(40),
	slices: [
		{ branch: "kstack/one", baseBranch: "refs/remotes/origin/main", headSha: "b".repeat(40), subject: "One" },
		{ branch: "kstack/two", baseBranch: "kstack/one", headSha: "c".repeat(40), subject: "Two" },
	],
};

describe("stack manifest", () => {
	it("accepts one exact bounded linear manifest", () => {
		assert.deepEqual(parseStackManifest(JSON.stringify(manifest)), { ok: true, manifest });
	});

	it("rejects extra keys, unsafe refs, duplicate branches, and broken chains", () => {
		assert.equal(parseStackManifest(JSON.stringify({ ...manifest, extra: true })).ok, false);
		assert.equal(parseStackManifest(JSON.stringify({ ...manifest, trunkRef: "bad..ref" })).ok, false);
		assert.equal(
			parseStackManifest(JSON.stringify({ ...manifest, slices: [manifest.slices[0], manifest.slices[0]] })).ok,
			false,
		);
		assert.equal(
			parseStackManifest(
				JSON.stringify({ ...manifest, slices: [manifest.slices[0], { ...manifest.slices[1], baseBranch: "main" }] }),
			).ok,
			false,
		);
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
		const oneSlice = { ...manifest, schemaVersion: 1 as const, slices: [manifest.slices[0]] };
		const result = await verifyStackManifestGitFacts("/repo", oneSlice, exec, "GitHub", signal);
		assert.equal(result.ok, true);
		assert.ok(seenSignals.length > 0);
		assert.ok(seenSignals.every((seen) => seen === signal));
	});

	it("enforces the slice bound", () => {
		const slices = Array.from({ length: MAX_STACK_SLICES + 1 }, (_, index) => ({
			branch: `kstack/${index}`,
			baseBranch: index === 0 ? manifest.trunkRef : `kstack/${index - 1}`,
			headSha: index.toString(16).padStart(40, "0"),
			subject: `Slice ${index}`,
		}));
		assert.equal(parseStackManifest(JSON.stringify({ ...manifest, slices })).ok, false);
	});
});

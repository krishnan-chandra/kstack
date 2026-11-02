import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecFn } from "../shared/git-exec.ts";
import { parseStackManifest } from "../shared/stack/manifest.ts";
import {
	planGraphitePublication,
	preflightGraphiteStack,
	publishGraphiteManifest,
	verifyGraphiteStack,
} from "./delivery.ts";

const trunkSha = "a".repeat(40);
const headSha = "b".repeat(40);
const manifestValue = {
	schemaVersion: 1,
	trunkRef: "main",
	trunkSha,
	slices: [{ branch: "kstack/one", baseBranch: "main", headSha, subject: "One" }],
} as const;

type ScriptedResults = Record<string, { code?: number; stdout?: string; stderr?: string }>;

function scripted(overrides: ScriptedResults = {}) {
	const calls: string[] = [];
	const defaults = {
		"git rev-parse --show-toplevel": { stdout: "/repo\n" },
		"git rev-parse --path-format=absolute --git-common-dir": { stdout: "/repo/.git\n" },
		"git status --porcelain=v1 --untracked-files=all": {},
		"git branch --show-current": { stdout: "kstack/one\n" },
		"git rev-parse --verify refs/heads/main^{commit}": { stdout: `${trunkSha}\n` },
		"git check-ref-format --branch kstack/one": {},
		"git rev-parse --verify refs/heads/kstack/one^{commit}": { stdout: `${headSha}\n` },
		[`git merge-base --is-ancestor ${trunkSha} ${headSha}`]: {},
		[`git diff --quiet ${trunkSha} ${headSha} --`]: { code: 1 },
		"gt --no-interactive --no-ai submit --stack --draft --no-edit --dry-run": {
			stdout: "Preparing to submit PRs for the following branches...\n▸ kstack/one (Create)\n✅ Dry run complete.\n",
		},
		"gh pr list --state open --head kstack/one --limit 2 --json number,url,headRefName,baseRefName,headRefOid,isDraft":
			{
				stdout: "[]\n",
			},
	};
	const defaultResponses = new Map<string, ScriptedResults[string]>(Object.entries(defaults));
	const exec: ExecFn = async (command, args) => {
		const key = `${command} ${args.join(" ")}`;
		calls.push(key);
		const response = overrides[key] ?? defaultResponses.get(key) ?? {};
		return { code: response.code ?? 0, stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
	};
	return { exec, calls };
}

describe("Graphite stack delivery", () => {
	it("rejects a dirty working tree before model work begins", async () => {
		const exec: ExecFn = async (command, args) => {
			const key = `${command} ${args.join(" ")}`;
			const responses = new Map<string, ScriptedResults[string]>(
				Object.entries({
					"gt --version": { stdout: "1.8.5\n" },
					"git --version": { stdout: "git version 2.38.0\n" },
					"git rev-parse --show-toplevel": { stdout: "/repo\n" },
					"gt --no-interactive trunk": { stdout: "main\n" },
					"git rev-parse --verify refs/heads/main^{commit}": { stdout: `${trunkSha}\n` },
					"git status --porcelain=v1 --untracked-files=all": { stdout: " M unrelated.ts\n" },
				} satisfies ScriptedResults),
			);
			const response = responses.get(key) ?? {};
			return { code: response.code ?? 0, stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
		};
		const result = await preflightGraphiteStack("/repo", "/tmp/manifest.json", exec);
		assert.deepEqual(result, {
			ok: false,
			error: "Graphite stack mode requires a clean working tree; commit, stash, or discard existing changes first.",
		});
	});

	it("plan-only accepts a dirty tree and needs no publication manifest", async () => {
		const { exec, calls } = scripted({
			"gt --version": { stdout: "1.8.5\n" },
			"git --version": { stdout: "git version 2.38.0\n" },
			"gt --no-interactive trunk": { stdout: "main\n" },
			"git status --porcelain=v1 --untracked-files=all": { stdout: " M existing.ts\n" },
		});
		const result = await preflightGraphiteStack("/repo", undefined, exec, true);
		assert.ok(result.ok);
		assert.equal(result.trunkSha, trunkSha);
		assert.equal(result.childPolicy, "");
		assert.equal(
			calls.some((call) => /submit|fetch|checkout|switch|status/.test(call)),
			false,
		);
	});

	it("accepts only a bounded, exact, linear kstack manifest", () => {
		const parsed = parseStackManifest(JSON.stringify(manifestValue));
		assert.equal(parsed.ok, true);
		assert.equal(parseStackManifest("{}").ok, false);
		assert.equal(parseStackManifest(JSON.stringify({ ...manifestValue, extra: true })).ok, false);
		assert.equal(
			parseStackManifest(
				JSON.stringify({ ...manifestValue, slices: [{ ...manifestValue.slices[0], branch: "kstack/bad..ref" }] }),
			).ok,
			false,
		);
	});

	it("verifies Git facts and Graphite's dry run before planning publication", async () => {
		const parsed = parseStackManifest(JSON.stringify(manifestValue));
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		const { exec, calls } = scripted();
		const verified = await verifyGraphiteStack("/repo", parsed.manifest, exec);
		assert.equal(verified.ok, true);
		if (!verified.ok) return;
		const planned = await planGraphitePublication(verified.stack, exec);
		assert.equal(planned.ok, true);
		assert.ok(calls.includes("gt --no-interactive --no-ai submit --stack --draft --no-edit --dry-run"));
		assert.match(planned.ok ? planned.plan.preview : "", /create draft PR: kstack\/one -> main/);
	});

	it("stops querying PRs once planning is cancelled", async () => {
		const parsed = parseStackManifest(JSON.stringify(manifestValue));
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		const { exec, calls } = scripted();
		const verified = await verifyGraphiteStack("/repo", parsed.manifest, exec);
		assert.equal(verified.ok, true);
		if (!verified.ok) return;
		const controller = new AbortController();
		controller.abort();
		const before = calls.length;
		const planned = await planGraphitePublication(verified.stack, exec, controller.signal);
		assert.equal(planned.ok, false);
		assert.equal(calls.length, before);
	});

	it("cancels a locked re-plan mid-query without further queries or a submit", async () => {
		const secondSha = "c".repeat(40);
		const manifest = parseStackManifest(
			JSON.stringify({
				...manifestValue,
				slices: [
					...manifestValue.slices,
					{ branch: "kstack/two", baseBranch: "kstack/one", headSha: secondSha, subject: "Two" },
				],
			}),
		);
		assert.equal(manifest.ok, true);
		if (!manifest.ok) return;
		const controller = new AbortController();
		const prQueries: string[] = [];
		const unexpected: string[] = [];
		const base = scripted({
			"git branch --show-current": { stdout: "kstack/two\n" },
			"git check-ref-format --branch kstack/two": {},
			"git rev-parse --verify refs/heads/kstack/two^{commit}": { stdout: `${secondSha}\n` },
			[`git merge-base --is-ancestor ${headSha} ${secondSha}`]: {},
			[`git diff --quiet ${headSha} ${secondSha} --`]: { code: 1 },
			"gt --no-interactive --no-ai submit --stack --draft --no-edit --dry-run": {
				stdout:
					"Preparing to submit PRs for the following branches...\n▸ kstack/one (Create)\n▸ kstack/two (Create)\n✅ Dry run complete.\n",
			},
		});
		const exec: ExecFn = async (command, args, options) => {
			if (command === "gh") {
				prQueries.push(args.join(" "));
				assert.equal(options.signal, controller.signal);
				// Queries 1-2 are the first plan; query 3 is the first slice of the locked re-plan.
				if (prQueries.length === 3) controller.abort();
				return { code: 0, stdout: "[]\n", stderr: "" };
			}
			if (command === "gt" && !args.includes("--dry-run")) unexpected.push(`${command} ${args.join(" ")}`);
			return base.exec(command, args, options);
		};
		let releases = 0;
		const result = await publishGraphiteManifest({
			cwd: "/repo",
			manifest: manifest.manifest,
			exec,
			ui: { hasUI: true, confirm: async () => true },
			signal: controller.signal,
			acquireLock: () => ({
				ok: true,
				lock: {
					release: () => {
						releases++;
						return { ok: true };
					},
				},
			}),
			realpath: (path) => path,
		});
		assert.deepEqual(result, { status: "cancelled" });
		assert.equal(prQueries.length, 3);
		assert.deepEqual(unexpected, []);
		assert.equal(releases, 1);
	});

	it("rejects a dry run whose affected branches differ from the manifest", async () => {
		const parsed = parseStackManifest(JSON.stringify(manifestValue));
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		const { exec } = scripted({
			"gt --no-interactive --no-ai submit --stack --draft --no-edit --dry-run": {
				stdout:
					"Preparing to submit PRs for the following branches...\n▸ kstack/unexpected (Update)\n▸ kstack/one (Create)\n✅ Dry run complete.\n",
			},
		});
		const verified = await verifyGraphiteStack("/repo", parsed.manifest, exec);
		assert.equal(verified.ok, false);
		assert.match(verified.ok ? "" : verified.error, /unexpected/);
	});

	it("re-plans under the lock, submits once, and verifies the exact draft PR", async () => {
		const parsed = parseStackManifest(JSON.stringify(manifestValue));
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		let ghReads = 0;
		const base = scripted();
		const exec: ExecFn = async (command, args, options) => {
			if (command === "gh") {
				ghReads++;
				const visible = ghReads >= 3;
				return {
					code: 0,
					stdout: visible
						? JSON.stringify([
								{
									number: 12,
									url: "https://example.test/pr/12",
									headRefName: "kstack/one",
									baseRefName: "main",
									headRefOid: headSha,
									isDraft: true,
								},
							])
						: "[]",
					stderr: "",
				};
			}
			return base.exec(command, args, options);
		};
		let released = false;
		const result = await publishGraphiteManifest({
			cwd: "/repo",
			manifest: parsed.manifest,
			exec,
			ui: { hasUI: true, confirm: async () => true },
			acquireLock: () => ({
				ok: true,
				lock: {
					release: () => {
						released = true;
						return { ok: true };
					},
				},
			}),
			realpath: (path) => path,
		});
		assert.equal(result.status, "completed");
		assert.equal(result.status === "completed" ? result.publication.pullRequests[0].prNumber : undefined, 12);
		assert.deepEqual(result.status === "completed" ? result.completedActions : undefined, [
			{ kind: "create-draft-pr", ref: "kstack/one", prNumber: 12, url: "https://example.test/pr/12" },
		]);
		assert.equal(
			base.calls.filter((call) => call === "gt --no-interactive --no-ai submit --stack --draft --no-edit").length,
			1,
		);
		assert.equal(released, true);
	});

	it("treats a nonzero submit as partial when exact PRs are visible", async () => {
		const parsed = parseStackManifest(JSON.stringify(manifestValue));
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		let ghReads = 0;
		const base = scripted({
			"gt --no-interactive --no-ai submit --stack --draft --no-edit": { code: 1, stderr: "connection lost" },
		});
		const exec: ExecFn = async (command, args, options) => {
			if (command === "gh") {
				ghReads++;
				return {
					code: 0,
					stdout:
						ghReads >= 3
							? JSON.stringify([
									{
										number: 12,
										url: "https://example.test/pr/12",
										headRefName: "kstack/one",
										baseRefName: "main",
										headRefOid: headSha,
										isDraft: true,
									},
								])
							: "[]",
					stderr: "",
				};
			}
			return base.exec(command, args, options);
		};
		const result = await publishGraphiteManifest({
			cwd: "/repo",
			manifest: parsed.manifest,
			exec,
			ui: { hasUI: true, confirm: async () => true },
			acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
			realpath: (path) => path,
		});
		assert.equal(result.status, "partial");
		assert.equal(result.status === "partial" ? result.publication?.pullRequests.length : 0, 1);
		assert.deepEqual(result.status === "partial" ? result.completedActions : [], [
			{ kind: "create-draft-pr", ref: "kstack/one", prNumber: 12, url: "https://example.test/pr/12" },
		]);
	});
});

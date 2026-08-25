import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExecFn } from "../shared/git-exec.ts";
import {
	parseGraphiteStackManifest,
	planGraphitePublication,
	submitGraphiteStack,
	verifyGraphiteStack,
} from "./graphite-stack-delivery.ts";

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
		"gh pr list --state open --head kstack/one --json number,url,headRefName,baseRefName,headRefOid,isDraft": {
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
	it("accepts only a bounded, exact, linear kstack manifest", () => {
		const parsed = parseGraphiteStackManifest(JSON.stringify(manifestValue));
		assert.equal(parsed.ok, true);
		assert.equal(parseGraphiteStackManifest("{}").ok, false);
		assert.equal(parseGraphiteStackManifest(JSON.stringify({ ...manifestValue, extra: true })).ok, false);
		assert.equal(
			parseGraphiteStackManifest(
				JSON.stringify({ ...manifestValue, slices: [{ ...manifestValue.slices[0], branch: "kstack/bad..ref" }] }),
			).ok,
			false,
		);
	});

	it("verifies Git facts and Graphite's dry run before planning publication", async () => {
		const parsed = parseGraphiteStackManifest(JSON.stringify(manifestValue));
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

	it("rejects a dry run whose affected branches differ from the manifest", async () => {
		const parsed = parseGraphiteStackManifest(JSON.stringify(manifestValue));
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

	it("revalidates under lock, submits once, and verifies the exact draft PR", async () => {
		const parsed = parseGraphiteStackManifest(JSON.stringify(manifestValue));
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
		const verified = await verifyGraphiteStack("/repo", parsed.manifest, exec);
		assert.equal(verified.ok, true);
		if (!verified.ok) return;
		const planned = await planGraphitePublication(verified.stack, exec);
		assert.equal(planned.ok, true);
		if (!planned.ok) return;
		let released = false;
		const result = await submitGraphiteStack(planned.plan, exec, {
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
		assert.equal(result.status === "completed" ? result.pullRequests[0].prNumber : undefined, 12);
		assert.equal(
			base.calls.filter((call) => call === "gt --no-interactive --no-ai submit --stack --draft --no-edit").length,
			1,
		);
		assert.equal(released, true);
	});

	it("treats a nonzero submit as partial when exact PRs are visible", async () => {
		const parsed = parseGraphiteStackManifest(JSON.stringify(manifestValue));
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
		const verified = await verifyGraphiteStack("/repo", parsed.manifest, exec);
		assert.equal(verified.ok, true);
		if (!verified.ok) return;
		const planned = await planGraphitePublication(verified.stack, exec);
		assert.equal(planned.ok, true);
		if (!planned.ok) return;
		const result = await submitGraphiteStack(planned.plan, exec, {
			acquireLock: () => ({ ok: true, lock: { release: () => ({ ok: true }) } }),
			realpath: (path) => path,
		});
		assert.equal(result.status, "partial");
		assert.equal(result.status === "partial" ? result.pullRequests.length : 0, 1);
	});
});

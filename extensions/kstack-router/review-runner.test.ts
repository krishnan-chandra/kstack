import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { HostedAgentSpec } from "../shared/herdr/agent-host.ts";
import { READ_ONLY_PROMPT_FILE } from "../shared/prompt-assets.ts";
import { buildReviewArgs, buildReviewPrompt, changesetDiff, runReviewRoute } from "./review-runner.ts";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.5, turns: 3 };
const missingSession = { kind: "missing" as const, reason: "not-reported" as const };

function fakePi(options: { exec?: ExtensionAPI["exec"]; sent?: Array<{ customType: string; content: string }> } = {}) {
	const exec = options.exec ?? (async () => ({ code: 0, stdout: "diff --git a/x b/x\n", stderr: "", killed: false }));
	const sendMessage = (message: { customType?: string; content?: unknown }) => {
		options.sent?.push({ customType: message.customType ?? "", content: String(message.content ?? "") });
	};
	const fixture = { exec, sendMessage };
	// SAFETY: This test controls the fixture and exercises only the asserted contract.
	return fixture as never;
}

function fakeCtx(available = true): ExtensionCommandContext {
	const fixture = {
		cwd: "/repo",
		modelRegistry: {
			find: (provider: string, modelId: string) => (available ? { provider, id: modelId } : undefined),
			hasConfiguredAuth: () => available,
			getRegisteredProviderIds: () => [],
		},
	};
	// SAFETY: This test controls the fixture and exercises only the asserted contract.
	return fixture as never;
}

const missingConfig = () => ({ status: "missing" as const, path: "/tmp/kstack.json" });

describe("buildReviewArgs", () => {
	it("loads the thermo skill and pinned model with discovery and a read-only contract", () => {
		const args = buildReviewArgs("anthropic/claude-opus-5-5", "high");
		const after = (flag: string) => args.slice(args.indexOf(flag), args.indexOf(flag) + 2);
		assert.ok(args.includes("--skill"));
		assert.ok(args.some((arg) => arg.includes("thermo-nuclear-code-quality-review")));
		assert.equal(args.includes("--tools"), false);
		assert.equal(args.includes("--no-extensions"), false);
		assert.match(after("--append-system-prompt")[1], /\/read-only\.md$/);
		assert.deepEqual(after("--model"), ["--model", "anthropic/claude-opus-5-5"]);
		assert.deepEqual(after("--thinking"), ["--thinking", "high"]);
	});
});

describe("changesetDiff", () => {
	it("uses jj when the workspace is jj", async () => {
		const calls: string[] = [];
		const exec: ExtensionAPI["exec"] = async (command, argv) => {
			calls.push(`${command} ${argv.join(" ")}`);
			if (command === "jj" && argv[0] === "workspace") return { code: 0, stdout: "/repo\n", stderr: "", killed: false };
			return { code: 0, stdout: "jj-diff", stderr: "", killed: false };
		};
		const result = await changesetDiff(fakePi({ exec }), "/repo");
		assert.equal(result.diff, "jj-diff");
		assert.ok(calls.some((call) => call.startsWith("jj diff")));
	});

	it("falls back to git and truncates a large diff", async () => {
		const exec: ExtensionAPI["exec"] = async (command) => {
			if (command === "jj") return { code: 1, stdout: "", stderr: "not jj", killed: false };
			return { code: 0, stdout: "x".repeat(200 * 1024), stderr: "", killed: false };
		};
		const result = await changesetDiff(fakePi({ exec }), "/repo");
		assert.equal(result.truncated, true);
		assert.ok(result.diff.length < 200 * 1024);
	});
});

describe("buildReviewPrompt", () => {
	it("includes the playbook, the task, and the changeset", () => {
		const prompt = buildReviewPrompt({
			task: "Review the parser.",
			diff: "diff --git a/x b/x",
			truncated: false,
			readAsset: () => "PLAYBOOK",
		});
		assert.ok(prompt.includes("PLAYBOOK"));
		assert.ok(prompt.includes("Review the parser."));
		assert.ok(prompt.includes("diff --git a/x b/x"));
	});

	it("uses a default task and notes an empty changeset", () => {
		const prompt = buildReviewPrompt({ task: "  ", diff: "", truncated: false, readAsset: () => "PLAYBOOK" });
		assert.ok(prompt.includes("Review the current changeset."));
		assert.ok(prompt.includes("(no changes detected)"));
	});
});

describe("runReviewRoute", () => {
	it("runs an isolated child and posts the verdict", async () => {
		const sent: Array<{ customType: string; content: string }> = [];
		const childArgs: string[][] = [];
		const result = await runReviewRoute(fakePi({ sent }), fakeCtx(), "Review the changes", undefined, {
			loadConfig: missingConfig,
			readAsset: () => "PLAYBOOK",
			selectTransport: () => "headless",
			runChild: async (options) => {
				childArgs.push(options.args);
				return { status: "completed", output: "Verdict: approve", usage, session: missingSession };
			},
		});
		assert.deepEqual(result, { status: "dispatched" });
		assert.equal(childArgs.length, 1);
		assert.ok(childArgs[0]?.includes("--model"));
		assert.ok(sent.some((message) => message.customType === "kstack-review" && message.content === "Verdict: approve"));
	});

	it("fails before dispatching when no review model is available", async () => {
		let childRuns = 0;
		const result = await runReviewRoute(fakePi(), fakeCtx(false), "Review", undefined, {
			loadConfig: missingConfig,
			readAsset: () => "PLAYBOOK",
			selectTransport: () => "headless",
			runChild: async () => {
				childRuns += 1;
				throw new Error("should not run");
			},
		});
		assert.equal(result.status, "failed");
		assert.equal(childRuns, 0);
	});

	it("reports a failed review child", async () => {
		const result = await runReviewRoute(fakePi(), fakeCtx(), "Review", undefined, {
			loadConfig: missingConfig,
			readAsset: () => "PLAYBOOK",
			selectTransport: () => "headless",
			runChild: async () => ({ status: "failed", error: "boom", usage, stderr: "", session: missingSession }),
		});
		assert.deepEqual(result, { status: "failed", error: "The review child failed: boom" });
	});

	it("runs the review in a Herdr pane when selected", async () => {
		const sent: Array<{ customType: string; content: string }> = [];
		const dir = mkdtempSync(join(tmpdir(), "kstack-review-"));
		try {
			const hostFixture = {
				exchangeDir: dir,
				start: async (spec: HostedAgentSpec) => {
					assert.deepEqual(spec.systemPromptFiles, [READ_ONLY_PROMPT_FILE]);
					assert.equal(spec.inheritExtensions, true);
					assert.equal(spec.tools, undefined);
					return {
						ok: true,
						agent: { ask: async () => ({ status: "completed", output: "Pane verdict", usage }) },
					};
				},
				dispose: async () => {},
			};
			// SAFETY: This test controls the fixture and exercises only the asserted contract.
			const openPane = (async () => ({ ok: true, host: hostFixture })) as never;
			// SAFETY: The fake pane host ignores the Herdr exec it is given.
			const exec = (() => {}) as never;
			const result = await runReviewRoute(fakePi({ sent }), fakeCtx(), "Review", undefined, {
				loadConfig: missingConfig,
				readAsset: () => "PLAYBOOK",
				selectTransport: () => "pane",
				createExec: () => exec,
				openPane,
			});
			assert.deepEqual(result, { status: "dispatched" });
			assert.ok(sent.some((message) => message.customType === "kstack-review" && message.content === "Pane verdict"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

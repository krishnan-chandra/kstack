import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { BoundaryValue } from "../shared/validation.ts";
import { createVcsTestEnv } from "../shared/vcs-test-env.ts";
import { PANEL_REVIEW_REQUEST_EVENT, requestPanelReview } from "./api.ts";
import panelReviewPlugin from "./index.ts";

const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("panel review context wiring", () => {
	it("checks provenance after assigning the snapshot review root and passes a synthesis recheck", () => {
		const snapshotAssignment = source.indexOf("scope = { ...scope, reviewRoot: prSnapshot.directory }");
		const provenanceCheck = source.indexOf("contextFilesTouchChangedContent({");
		assert.ok(snapshotAssignment >= 0);
		assert.ok(provenanceCheck > snapshotAssignment);
		assert.match(source, /checkContextProvenance,\n\s+waitForIdle/);
	});

	it("ensures a changed pinned scope reaches review setup instead of taking the no-changes return", async () => {
		const root = mkdtempSync(join(tmpdir(), "panel-index-replace-"));
		const repo = join(root, "repo");
		const binDir = join(root, "bin");
		const agentDir = join(root, "agent");
		mkdirSync(repo);
		mkdirSync(binDir);
		mkdirSync(agentDir);

		const vcsEnv = createVcsTestEnv(root);
		const run = (cwd: string, cmd: string, args: string[]) => {
			const r = spawnSync(cmd, args, { cwd, env: vcsEnv, encoding: "utf8" });
			assert.equal(r.status, 0, r.stderr || r.error?.message);
			return r.stdout.trim();
		};

		run(repo, "git", ["init", "-q"]);
		run(repo, "git", ["config", "user.name", "Test"]);
		run(repo, "git", ["config", "user.email", "test@example.com"]);
		run(repo, "git", ["remote", "add", "origin", repo]);
		writeFileSync(join(repo, "base.txt"), "base\n");
		run(repo, "git", ["add", "base.txt"]);
		run(repo, "git", ["commit", "-qm", "base"]);
		run(repo, "git", ["branch", "-M", "main"]);
		const baseSha = run(repo, "git", ["rev-parse", "HEAD"]);

		writeFileSync(join(repo, "changed.txt"), "changed\n");
		run(repo, "git", ["add", "changed.txt"]);
		run(repo, "git", ["commit", "-qm", "changed"]);
		const headSha = run(repo, "git", ["rev-parse", "HEAD"]);
		run(repo, "git", ["update-ref", "refs/pull/42/head", headSha]);

		// Replace headSha with baseSha so ordinary Git sees no changes
		run(repo, "git", ["replace", headSha, baseSha]);

		const mockPi = join(binDir, "pi");
		writeFileSync(
			mockPi,
			`#!/usr/bin/env node
const args = process.argv;
const idIdx = args.indexOf("--session-id");
const id = idIdx >= 0 ? args[idIdx + 1] : "00000000-0000-4000-8000-000000000001";
console.log(JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: process.cwd() }));
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "## Act On\\nnone" }] } }));
`,
		);
		chmodSync(mockPi, 0o755);

		const oldPath = process.env.PATH;
		const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
		const oldArgv1 = process.argv[1];
		process.env.PATH = `${binDir}:${oldPath}`;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.argv[1] = "";

		try {
			let requestListener: ((data: BoundaryValue) => void) | undefined;
			const pi = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
				events: {
					on: (ev: string, fn: (data: BoundaryValue) => void) => {
						if (ev === PANEL_REVIEW_REQUEST_EVENT) requestListener = fn;
					},
					emit: (ev: string, data: BoundaryValue) => {
						if (ev === PANEL_REVIEW_REQUEST_EVENT) requestListener?.(data);
					},
				},
				registerCommand: () => {},
				registerShortcut: () => {},
				registerMessageRenderer: () => {},
				sendMessage: () => {},
				on: () => {},
				exec: async (command: string, args: string[], options?: { cwd?: string }) => {
					if (command === "gh") {
						return {
							code: 0,
							stdout: JSON.stringify({
								number: 42,
								url: "https://github.com/owner/repo/pull/42",
								title: "Add feature X",
								state: "OPEN",
								headRefOid: headSha,
								baseRefName: "main",
								baseRefOid: baseSha,
							}),
							stderr: "",
						};
					}
					const res = spawnSync(command, args, { cwd: options?.cwd, env: vcsEnv, encoding: "utf8" });
					return { code: res.status ?? 0, stdout: res.stdout, stderr: res.stderr || res.error?.message || "" };
				},
			} as never;

			panelReviewPlugin(pi);

			const ctx = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ {
				cwd: repo,
				hasUI: true,
				sessionManager: { getSessionId: () => "test-session" },
				waitForIdle: async () => {},
				modelRegistry: {
					find: (p: string, id: string) => ({ provider: p, id }),
					hasConfiguredAuth: () => true,
					getRegisteredProviderIds: () => [],
					getProviderAuthStatus: () => ({ configured: true }),
				},
				scopedModels: [],
				model: { provider: "anthropic", id: "claude-sonnet-5" },
				ui: {
					editor: async () => "intent",
					notify: () => {},
					setStatus: () => {},
				},
			} as never;

			const result = await requestPanelReview(pi, { pr: 42, intent: "review this PR" }, ctx);
			assert.equal(result.handled, true);
			assert.notEqual(result.outcome?.status, "no-changes");
			assert.equal(result.outcome?.status, "completed");
			assert.equal(result.outcome?.headSha, headSha);
			assert.equal(result.outcome?.baseSha, baseSha);
		} finally {
			process.env.PATH = oldPath;
			if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
			process.argv[1] = oldArgv1;
			rmSync(root, { recursive: true, force: true });
		}
	});
});

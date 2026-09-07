import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { HostDeps } from "./agent-host.ts";
import {
	type FanoutAccess,
	type FanoutOutcome,
	type FanoutSpec,
	type FanoutTask,
	type FanoutTaskResult,
	parseFanoutSpec,
	runFanout,
} from "./fanout.ts";

interface ExecCall {
	args: string[];
	timeoutMs: number;
}

interface AgentFixture {
	agent: string;
	agent_status: string;
	name: string;
	pane_id: string;
	tab_id: string;
	agent_session: { kind: string; value: string };
}

function agentRecord(status: string, paneId: string, sessionFile: string): AgentFixture {
	return {
		agent: "pi",
		agent_status: status,
		name: "unused",
		pane_id: paneId,
		tab_id: "w5:tHost",
		agent_session: { kind: "path", value: sessionFile },
	};
}

class FakeHerdr {
	readonly calls: ExecCall[] = [];
	tabId = "w5:tHost";
	rootPaneId = "w5:pRoot";
	sessionFile: string;
	activeConcurrentPrompts = 0;
	peakConcurrentPrompts = 0;
	promptDelayMs = 0;
	agentStatusByRole = new Map<string, string>();
	private nextPaneNumber = 100;
	private readonly agentDir: string;

	constructor(agentDir: string) {
		this.agentDir = agentDir;
		this.sessionFile = join(this.agentDir, "hosted-session.jsonl");
	}

	get env(): NodeJS.ProcessEnv {
		return {
			HERDR_ENV: "1",
			HERDR_WORKSPACE_ID: "w5",
			HERDR_PANE_ID: "w5:pCaller",
			PI_CODING_AGENT_DIR: this.agentDir,
		};
	}

	deps(): HostDeps {
		return {
			exec: this.exec,
			env: this.env,
		};
	}

	appendUsage(input: number, output: number, cost: number): void {
		appendFileSync(
			this.sessionFile,
			`${JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					usage: { input, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
				},
			})}\n`,
		);
	}

	readonly exec: HostDeps["exec"] = async (args, options) => {
		const call: ExecCall = { args, timeoutMs: options.timeoutMs };
		this.calls.push(call);
		const joined = args.join(" ");
		if (joined.startsWith("status server")) {
			return { code: 0, stdout: "status: running\n", stderr: "" };
		}
		if (joined.startsWith("tab create")) {
			return {
				code: 0,
				stdout: JSON.stringify({
					id: "x",
					result: {
						type: "tab_created",
						tab: { tab_id: this.tabId },
						root_pane: { pane_id: this.rootPaneId },
					},
				}),
				stderr: "",
			};
		}
		if (joined.startsWith("pane layout")) {
			return {
				code: 0,
				stdout: JSON.stringify({
					id: "x",
					result: { type: "pane_layout", layout: { area: { width: 240, height: 60 } } },
				}),
				stderr: "",
			};
		}
		if (joined.startsWith("pane split")) {
			const paneId = `w5:p${this.nextPaneNumber++}`;
			return {
				code: 0,
				stdout: JSON.stringify({
					id: "x",
					result: { type: "pane_info", pane: { pane_id: paneId, tab_id: this.tabId, agent_status: "unknown" } },
				}),
				stderr: "",
			};
		}
		if (joined.startsWith("pane close") || joined.startsWith("tab close")) {
			return { code: 0, stdout: '{"id":"x","result":{"type":"ok"}}', stderr: "" };
		}
		if (joined.startsWith("agent start")) {
			const paneId = args[5] ?? this.rootPaneId;
			return {
				code: 0,
				stdout: JSON.stringify({
					id: "x",
					result: { type: "agent_started", agent: agentRecord("idle", paneId, this.sessionFile), argv: ["pi"] },
				}),
				stderr: "",
			};
		}
		if (joined.startsWith("agent prompt")) {
			const agentName = args[2] ?? "";
			const promptText = args[3] ?? "";
			const match = /DONE\s+(\S+)/.exec(promptText);
			if (match) {
				const outPath = match[1];
				try {
					writeFileSync(outPath, "simulated answer\n");
				} catch {
					/* ignore */
				}
			}
			this.activeConcurrentPrompts++;
			if (this.activeConcurrentPrompts > this.peakConcurrentPrompts) {
				this.peakConcurrentPrompts = this.activeConcurrentPrompts;
			}
			if (this.promptDelayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, this.promptDelayMs));
			}
			this.activeConcurrentPrompts--;
			let status = "idle";
			for (const [role, roleStatus] of this.agentStatusByRole) {
				if (agentName.includes(role)) {
					status = roleStatus;
					break;
				}
			}
			return {
				code: 0,
				stdout: JSON.stringify({
					id: "x",
					result: { type: "agent_prompted", agent: agentRecord(status, this.rootPaneId, this.sessionFile) },
				}),
				stderr: "",
			};
		}
		if (joined.startsWith("agent wait") || joined.startsWith("agent get")) {
			return {
				code: 0,
				stdout: JSON.stringify({
					id: "x",
					result: { type: "agent_info", agent: agentRecord("idle", this.rootPaneId, this.sessionFile) },
				}),
				stderr: "",
			};
		}
		if (joined.startsWith("agent read")) {
			return { code: 0, stdout: "", stderr: "" };
		}
		if (joined.startsWith("agent send-keys")) {
			return { code: 0, stdout: '{"id":"x","result":{"type":"ok"}}', stderr: "" };
		}
		throw new Error(`FakeHerdr has no route for: ${joined}`);
	};
}

describe("parseFanoutSpec", () => {
	it("parses valid spec with default and custom task settings", () => {
		const parsed = parseFanoutSpec({
			owner: "arena",
			label: "comparison",
			cwd: "/repo",
			tasks: [
				{
					label: "terra",
					model: "openai/gpt-5.6-terra:high",
					cwd: "/repo/worktree-a",
					promptFile: "/tmp/a.md",
					outputFile: "/tmp/out-a.md",
				},
				{
					label: "kimi",
					model: "openrouter/moonshotai/kimi-k3",
					cwd: "/repo/worktree-b",
					promptFile: "/tmp/b.md",
					outputFile: "/tmp/out-b.md",
					access: "workspace",
					tools: ["read", "bash"],
					noContextFiles: false,
					timeoutMinutes: 45,
				},
			],
			maxConcurrency: 3,
		});
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		const spec: FanoutSpec = parsed.spec;
		assert.equal(spec.owner, "arena");
		assert.equal(spec.label, "comparison");
		assert.equal(spec.cwd, "/repo");
		assert.equal(spec.maxConcurrency, 3);
		assert.equal(spec.tasks.length, 2);
		const task0: FanoutTask = spec.tasks[0];
		assert.equal(task0.label, "terra");
		assert.equal(task0.model, "openai/gpt-5.6-terra:high");
		assert.equal(task0.access, "read-only");
		assert.equal(task0.noContextFiles, true);
		assert.equal(task0.timeoutMinutes, 30);
		const task1: FanoutTask = spec.tasks[1];
		assert.equal(task1.label, "kimi");
		assert.equal(task1.access, "workspace");
		assert.deepEqual(task1.tools, ["read", "bash"]);
		assert.equal(task1.noContextFiles, false);
		assert.equal(task1.timeoutMinutes, 45);
	});

	it("rejects non-object, missing fields, and bad bounds", () => {
		assert.equal(parseFanoutSpec(null).ok, false);
		assert.equal(parseFanoutSpec([]).ok, false);
		assert.equal(parseFanoutSpec({ owner: "INVALID_UPPER", label: "x", cwd: "/repo", tasks: [] }).ok, false);
		assert.equal(parseFanoutSpec({ owner: "arena", label: "", cwd: "/repo", tasks: [] }).ok, false);
		assert.equal(parseFanoutSpec({ owner: "arena", label: "x", cwd: "relative/path", tasks: [] }).ok, false);
		assert.equal(parseFanoutSpec({ owner: "arena", label: "x", cwd: "/repo", tasks: [] }).ok, false);
		assert.equal(
			parseFanoutSpec({
				owner: "arena",
				label: "x",
				cwd: "/repo",
				tasks: Array.from({ length: 9 }, (_, i) => ({
					label: `t${i}`,
					model: "openai/gpt-5.6-terra",
					cwd: "/repo",
					promptFile: "/tmp/p.md",
					outputFile: "/tmp/o.md",
				})),
			}).ok,
			false,
		);
		assert.equal(
			parseFanoutSpec({
				owner: "arena",
				label: "x",
				cwd: "/repo",
				tasks: [
					{
						label: "t1",
						model: "openai/gpt-5.6-terra",
						cwd: "/repo",
						promptFile: "/tmp/p.md",
						outputFile: "/tmp/o.md",
					},
				],
				maxConcurrency: 0,
			}).ok,
			false,
		);
	});

	it("rejects bad task properties including non-read-only tools on read-only tasks", () => {
		const baseTask = {
			label: "t1",
			model: "openai/gpt-5.6-terra",
			cwd: "/repo",
			promptFile: "/tmp/p.md",
			outputFile: "/tmp/o.md",
		};
		assert.equal(
			parseFanoutSpec({
				owner: "arena",
				label: "x",
				cwd: "/repo",
				tasks: [{ ...baseTask, label: "INVALID!" }],
			}).ok,
			false,
		);
		assert.equal(
			parseFanoutSpec({
				owner: "arena",
				label: "x",
				cwd: "/repo",
				tasks: [{ ...baseTask, model: "bad_model_ref" }],
			}).ok,
			false,
		);
		assert.equal(
			parseFanoutSpec({
				owner: "arena",
				label: "x",
				cwd: "/repo",
				tasks: [{ ...baseTask, promptFile: "relative/path.md" }],
			}).ok,
			false,
		);
		assert.equal(
			parseFanoutSpec({
				owner: "arena",
				label: "x",
				cwd: "/repo",
				tasks: [{ ...baseTask, access: "read-only", tools: ["read", "bash"] }],
			}).ok,
			false,
		);
		assert.equal(
			parseFanoutSpec({
				owner: "arena",
				label: "x",
				cwd: "/repo",
				tasks: [{ ...baseTask, timeoutMinutes: 100 }],
			}).ok,
			false,
		);
	});
});

describe("runFanout", () => {
	const tempDirs: string[] = [];

	after(() => {
		for (const dir of tempDirs) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				/* cleanup */
			}
		}
	});

	function makeTempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	it("runs tasks with bounded concurrency and preserves input order", async () => {
		const agentDir = makeTempDir("fanout-agent-");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(join(agentDir, "extensions", "herdr-agent-state.ts"), "// fake integration\n");
		const repoDir = makeTempDir("fanout-repo-");
		const promptDir = makeTempDir("fanout-prompts-");
		const outputDir = makeTempDir("fanout-outputs-");

		const taskA: FanoutTask = {
			label: "candidate-a",
			model: "openai/gpt-5.6-terra:high",
			cwd: repoDir,
			promptFile: join(promptDir, "a.md"),
			outputFile: join(outputDir, "out-a.md"),
			access: "read-only",
			noContextFiles: true,
			timeoutMinutes: 10,
		};
		const taskB: FanoutTask = {
			label: "candidate-b",
			model: "openai/gpt-5.6-sol:medium",
			cwd: repoDir,
			promptFile: join(promptDir, "b.md"),
			outputFile: join(outputDir, "out-b.md"),
			access: "read-only",
			noContextFiles: true,
			timeoutMinutes: 10,
		};
		const taskC: FanoutTask = {
			label: "candidate-c",
			model: "anthropic/claude-fable-5-1",
			cwd: repoDir,
			promptFile: join(promptDir, "c.md"),
			outputFile: join(outputDir, "out-c.md"),
			access: "read-only",
			noContextFiles: true,
			timeoutMinutes: 10,
		};

		writeFileSync(taskA.promptFile, "prompt a");
		writeFileSync(taskB.promptFile, "prompt b");
		writeFileSync(taskC.promptFile, "prompt c");
		writeFileSync(taskA.outputFile, "result a");
		writeFileSync(taskB.outputFile, "result b");
		writeFileSync(taskC.outputFile, "result c");

		const fake = new FakeHerdr(agentDir);
		fake.promptDelayMs = 20;
		fake.appendUsage(100, 50, 0.01);

		const result = await runFanout(
			{
				owner: "arena",
				label: "three-candidates",
				cwd: repoDir,
				tasks: [taskA, taskB, taskC],
				maxConcurrency: 2,
			},
			fake.deps(),
		);

		assert.equal(result.ok, true);
		if (!result.ok) return;
		const outcome: FanoutOutcome = result.outcome;
		assert.equal(outcome.tabId, "w5:tHost");
		assert.equal(outcome.results.length, 3);
		assert.equal(fake.peakConcurrentPrompts <= 2, true);

		// Results strictly preserve input order
		const [resA, resB, resC] = outcome.results;
		assert.ok(resA);
		assert.ok(resB);
		assert.ok(resC);
		const checkResult: FanoutTaskResult = resA;
		assert.equal(checkResult.label, "candidate-a");
		const checkAccess: FanoutAccess = taskA.access;
		assert.equal(checkAccess, "read-only");
		assert.equal(resA.label, "candidate-a");
		assert.equal(resA.status, "completed");
		assert.equal(resB.label, "candidate-b");
		assert.equal(resB.status, "completed");
		assert.equal(resC.label, "candidate-c");
		assert.equal(resC.status, "completed");
	});

	it("rejects duplicate task labels", async () => {
		const agentDir = makeTempDir("fanout-agent-");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(join(agentDir, "extensions", "herdr-agent-state.ts"), "// fake integration\n");
		const repoDir = makeTempDir("fanout-repo-");
		const promptFile = join(repoDir, "p.md");
		writeFileSync(promptFile, "prompt");

		const fake = new FakeHerdr(agentDir);
		const result = await runFanout(
			{
				owner: "arena",
				label: "dupe",
				cwd: repoDir,
				tasks: [
					{
						label: "dupe-label",
						model: "openai/gpt-5.6-terra",
						cwd: repoDir,
						promptFile,
						outputFile: join(repoDir, "out1.md"),
						access: "read-only",
						noContextFiles: true,
						timeoutMinutes: 10,
					},
					{
						label: "dupe-label",
						model: "openai/gpt-5.6-sol",
						cwd: repoDir,
						promptFile,
						outputFile: join(repoDir, "out2.md"),
						access: "read-only",
						noContextFiles: true,
						timeoutMinutes: 10,
					},
				],
				maxConcurrency: 2,
			},
			fake.deps(),
		);

		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.match(result.error, /Duplicate task label: dupe-label/);
		}
	});

	it("rejects writable tasks inside the repo root or overlapping each other", async () => {
		const agentDir = makeTempDir("fanout-agent-");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(join(agentDir, "extensions", "herdr-agent-state.ts"), "// fake integration\n");
		const repoDir = makeTempDir("fanout-repo-");
		const promptFile = join(agentDir, "p.md");
		writeFileSync(promptFile, "prompt");

		const fake = new FakeHerdr(agentDir);

		// Inside repo root
		const insideDir = join(repoDir, "nested-worktree");
		mkdirSync(insideDir, { recursive: true });
		const resultInside = await runFanout(
			{
				owner: "arena",
				label: "inside",
				cwd: repoDir,
				tasks: [
					{
						label: "inside-task",
						model: "openai/gpt-5.6-terra",
						cwd: insideDir,
						promptFile,
						outputFile: join(agentDir, "out.md"),
						access: "workspace",
						noContextFiles: true,
						timeoutMinutes: 10,
					},
				],
				maxConcurrency: 1,
			},
			fake.deps(),
		);
		assert.equal(resultInside.ok, false);
		if (!resultInside.ok) {
			assert.match(resultInside.error, /cannot use, contain, or be inside the repository root/);
		}

		// Overlapping writable directories
		const outsideDirA = makeTempDir("fanout-outside-");
		const outsideDirNested = join(outsideDirA, "child");
		mkdirSync(outsideDirNested, { recursive: true });
		const resultOverlap = await runFanout(
			{
				owner: "arena",
				label: "overlap",
				cwd: repoDir,
				tasks: [
					{
						label: "parent-task",
						model: "openai/gpt-5.6-terra",
						cwd: outsideDirA,
						promptFile,
						outputFile: join(agentDir, "out1.md"),
						access: "workspace",
						noContextFiles: true,
						timeoutMinutes: 10,
					},
					{
						label: "child-task",
						model: "openai/gpt-5.6-sol",
						cwd: outsideDirNested,
						promptFile,
						outputFile: join(agentDir, "out2.md"),
						access: "workspace",
						noContextFiles: true,
						timeoutMinutes: 10,
					},
				],
				maxConcurrency: 2,
			},
			fake.deps(),
		);
		assert.equal(resultOverlap.ok, false);
		if (!resultOverlap.ok) {
			assert.match(resultOverlap.error, /Writable task directories overlap/);
		}
	});

	it("handles partial task failure while returning all results in order", async () => {
		const agentDir = makeTempDir("fanout-agent-");
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(join(agentDir, "extensions", "herdr-agent-state.ts"), "// fake integration\n");
		const repoDir = makeTempDir("fanout-repo-");
		const promptDir = makeTempDir("fanout-prompts-");
		const outputDir = makeTempDir("fanout-outputs-");

		const taskGood: FanoutTask = {
			label: "good",
			model: "openai/gpt-5.6-terra",
			cwd: repoDir,
			promptFile: join(promptDir, "good.md"),
			outputFile: join(outputDir, "good-out.md"),
			access: "read-only",
			noContextFiles: true,
			timeoutMinutes: 10,
		};
		const taskBlocked: FanoutTask = {
			label: "blocked",
			model: "openai/gpt-5.6-sol",
			cwd: repoDir,
			promptFile: join(promptDir, "blocked.md"),
			outputFile: join(outputDir, "blocked-out.md"),
			access: "read-only",
			noContextFiles: true,
			timeoutMinutes: 10,
		};

		writeFileSync(taskGood.promptFile, "prompt good");
		writeFileSync(taskBlocked.promptFile, "prompt blocked");
		writeFileSync(taskGood.outputFile, "good result");

		const fake = new FakeHerdr(agentDir);
		fake.agentStatusByRole.set("blocked", "blocked");

		const result = await runFanout(
			{
				owner: "simplify",
				label: "lenses",
				cwd: repoDir,
				tasks: [taskGood, taskBlocked],
				maxConcurrency: 2,
			},
			fake.deps(),
		);

		assert.equal(result.ok, true);
		if (!result.ok) return;
		assert.equal(result.outcome.results.length, 2);
		const [first, second] = result.outcome.results;
		assert.equal(first.label, "good");
		assert.equal(first.status, "completed");
		assert.equal(second.label, "blocked");
		assert.equal(second.status, "blocked");
		if (second.status === "blocked") {
			assert.match(second.error, /blocked in pane/);
		}
	});
});

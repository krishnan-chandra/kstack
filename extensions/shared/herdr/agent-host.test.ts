import assert from "node:assert/strict";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import {
	type AgentHost,
	type AskOptions,
	buildAgentName,
	extractDonePath,
	type HostDeps,
	type HostedAgent,
	type HostedAgentSpec,
	hostedAgentArgs,
	openAgentHost,
	POINTER_PROMPT_MAX_BYTES,
	pointerPrompt,
	preflightHerdr,
} from "./agent-host.ts";

interface ExecCall {
	args: string[];
	timeoutMs: number;
}

type ExecResponse = { code: number; stdout: string; stderr: string };
type ExecHandler = (call: ExecCall) => ExecResponse | Promise<ExecResponse>;

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

/** Scripted fake over the herdr CLI surface: defaults mirror herdr 0.8.2 responses. */
class FakeHerdr {
	readonly calls: ExecCall[] = [];
	private readonly routes: Array<{ match: (args: string[]) => boolean; handler: ExecHandler }> = [];
	tabId = "w5:tHost";
	rootPaneId = "w5:pRoot";
	callerPaneId = "w5:pCaller";
	sessionFile: string;
	agentStatus = "idle";
	readOutput = "";
	/** Called whenever an `agent prompt` is accepted, before the response is produced. */
	onPrompt: ((call: ExecCall) => void) | undefined;
	sleptMs: number[] = [];
	private nextPaneNumber = 100;
	private nextTabNumber = 200;

	private readonly agentDir: string;

	constructor(agentDir: string) {
		this.agentDir = agentDir;
		this.sessionFile = join(this.agentDir, "hosted-session.jsonl");
	}

	get env(): NodeJS.ProcessEnv {
		return {
			HERDR_ENV: "1",
			HERDR_WORKSPACE_ID: "w5",
			HERDR_PANE_ID: this.callerPaneId,
			PI_CODING_AGENT_DIR: this.agentDir,
		};
	}

	get integrationPath(): string {
		return join(this.agentDir, "extensions", "herdr-agent-state.ts");
	}

	deps(): HostDeps {
		return {
			exec: this.exec,
			env: this.env,
			sleep: async (ms) => {
				this.sleptMs.push(ms);
			},
		};
	}

	on(match: (args: string[]) => boolean, handler: ExecHandler): this {
		this.routes.push({ match, handler });
		return this;
	}

	/** Queue responses for successive `agent prompt` calls. */
	promptResponses: Array<ExecResponse | "accept"> = [];

	appendSession(messages: Array<{ input: number; output: number; cost: number }>): void {
		for (const message of messages) {
			appendFileSync(
				this.sessionFile,
				`${JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						usage: {
							input: message.input,
							output: message.output,
							cacheRead: 0,
							cacheWrite: 0,
							cost: { total: message.cost },
						},
					},
				})}\n`,
			);
		}
	}

	readonly exec: HostDeps["exec"] = async (args, options) => {
		const call: ExecCall = { args, timeoutMs: options.timeoutMs };
		this.calls.push(call);
		const joined = args.join(" ");
		for (const route of this.routes) {
			if (route.match(args)) return route.handler(call);
		}
		if (joined.startsWith("status server")) return { code: 0, stdout: "status: running\n", stderr: "" };
		if (joined.startsWith("tab create")) {
			const tabId = `w5:t${this.nextTabNumber++}`;
			const paneId = `w5:p${this.nextPaneNumber++}`;
			this.tabId = tabId;
			this.rootPaneId = paneId;
			return {
				code: 0,
				stdout: JSON.stringify({
					id: "x",
					result: { type: "tab_created", tab: { tab_id: tabId }, root_pane: { pane_id: paneId } },
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
			const queued = this.promptResponses.shift();
			if (queued && queued !== "accept") return queued;
			this.onPrompt?.(call);
			return {
				code: 0,
				stdout: JSON.stringify({
					id: "x",
					result: { type: "agent_prompted", agent: agentRecord(this.agentStatus, this.rootPaneId, this.sessionFile) },
				}),
				stderr: "",
			};
		}
		if (joined.startsWith("agent wait") || joined.startsWith("agent get")) {
			return {
				code: 0,
				stdout: JSON.stringify({
					id: "x",
					result: { type: "agent_info", agent: agentRecord(this.agentStatus, this.rootPaneId, this.sessionFile) },
				}),
				stderr: "",
			};
		}
		if (joined.startsWith("agent read")) {
			return { code: 0, stdout: this.readOutput, stderr: "" };
		}
		if (joined.startsWith("agent send-keys")) {
			return { code: 0, stdout: '{"id":"x","result":{"type":"ok"}}', stderr: "" };
		}
		throw new Error(`FakeHerdr has no route for: ${joined}`);
	};

	callsMatching(prefix: string): ExecCall[] {
		return this.calls.filter((call) => call.args.join(" ").startsWith(prefix));
	}

	paneIdsTouched(prefix: string): string[] {
		return this.callsMatching(prefix)
			.map((call) => call.args.find((arg) => arg.startsWith("w5:p")))
			.filter((id): id is string => id !== undefined);
	}
}

const PLANNER_SPEC: HostedAgentSpec = {
	role: "planner",
	model: "a/planner",
	cwd: "/repo",
	tools: ["read", "grep", "find", "ls"],
	noSkills: true,
	noContextFiles: true,
};

interface Harness {
	fake: FakeHerdr;
	root: string;
	instructionsFile: string;
	outputFile: string;
}

const harnessRoots: string[] = [];

function makeHarness(label: string): Harness {
	const root = mkdtempSync(join(tmpdir(), `kstack-agent-host-${label}-`));
	harnessRoots.push(root);
	const fake = new FakeHerdr(root);
	// A fake integration file inside the fake agent dir satisfies preflight.
	mkdirSync(dirname(fake.integrationPath), { recursive: true });
	writeFileSync(fake.integrationPath, "// integration\n");
	const instructionsFile = join(root, "instructions.md");
	writeFileSync(instructionsFile, "# Instructions\n", { mode: 0o600 });
	return {
		fake,
		root,
		instructionsFile,
		outputFile: join(root, "answer.md"),
	};
}

async function startOne(fake: FakeHerdr, maxAgents = 1): Promise<{ host: AgentHost; agent: HostedAgent }> {
	const opened = await openAgentHost({ owner: "plan-implement", label: "test", cwd: "/repo", maxAgents }, fake.deps());
	assert.ok(opened.ok, opened.ok ? "" : opened.error);
	const agent = await opened.host.start(PLANNER_SPEC);
	assert.ok(agent.ok, agent.ok ? "" : agent.error);
	return { host: opened.host, agent: agent.agent };
}

function askOptions(harness: Harness, overrides: Partial<AskOptions> = {}): AskOptions {
	return {
		promptFile: harness.instructionsFile,
		outputFile: harness.outputFile,
		timeoutMs: 60_000,
		...overrides,
	};
}

describe("preflightHerdr", () => {
	it("passes with env, integration file, and a reachable server", async () => {
		const harness = makeHarness("preflight-ok");
		const result = await preflightHerdr(harness.fake.deps());
		assert.ok(result.ok);
		if (result.ok) {
			assert.equal(result.integrationPath, harness.fake.integrationPath);
			assert.equal(result.workspaceId, "w5");
			assert.equal(result.callerPane, harness.fake.callerPaneId);
		}
	});

	it("fails outside Herdr before touching the CLI", async () => {
		const harness = makeHarness("preflight-noenv");
		const result = await preflightHerdr({ exec: harness.fake.exec, env: {} });
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /HERDR_ENV/);
		assert.equal(harness.fake.calls.length, 0);
	});

	it("fails when the Pi integration is missing", async () => {
		const harness = makeHarness("preflight-nointegration");
		rmSync(harness.fake.integrationPath, { force: true });
		const result = await preflightHerdr(harness.fake.deps());
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /herdr integration install pi/);
		assert.equal(harness.fake.calls.length, 0);
	});

	it("fails when the herdr server is unreachable", async () => {
		const harness = makeHarness("preflight-server");
		harness.fake.on(
			(args) => args.join(" ").startsWith("status server"),
			() => ({
				code: 1,
				stdout: "",
				stderr: "connection refused",
			}),
		);
		const result = await preflightHerdr(harness.fake.deps());
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error, /Herdr is not reachable/);
	});
});

describe("agent-host: layout and start", () => {
	it("creates exactly one no-focus tab and never touches the caller's pane", async () => {
		const harness = makeHarness("layout");
		const opened = await openAgentHost(
			{ owner: "plan-implement", label: "run", cwd: "/repo", maxAgents: 4 },
			harness.fake.deps(),
		);
		assert.ok(opened.ok);
		const tabCreate = harness.fake.callsMatching("tab create")[0];
		assert.ok(tabCreate);
		const labelIndex = tabCreate.args.indexOf("--label");
		assert.equal(tabCreate.args[labelIndex + 1], "plan-implement: run");
		assert.ok(tabCreate.args.includes("--no-focus"));
		await opened.host.dispose();
		assert.equal(harness.fake.callsMatching("tab close").length, 0);
		assert.equal(harness.fake.callsMatching("pane close").length, 0);
	});

	it("splits panes for agents after the first and passes the isolation argv", async () => {
		const harness = makeHarness("start");
		const { host } = await startOne(harness.fake, 4);
		const first = harness.fake.callsMatching("agent start")[0];
		assert.ok(first);
		assert.ok(first.args.includes(harness.fake.rootPaneId));
		assert.ok(first.args.includes("--no-extensions"));
		assert.ok(first.args.includes(hostedAgentArgs(PLANNER_SPEC, harness.fake.integrationPath).at(-1) ?? ""));
		const second = await host.start({ ...PLANNER_SPEC, role: "adversary" });
		assert.ok(second.ok);
		const split = harness.fake.callsMatching("pane split")[0];
		assert.ok(split);
		assert.deepEqual(split.args.slice(2, 6), [harness.fake.rootPaneId, "--direction", "right", "--ratio"]);
		await host.dispose({ closeTab: true });
		assert.equal(harness.fake.callsMatching("tab close").length, 1);
	});

	it("rejects starts beyond maxAgents and refuses to split the caller pane", async () => {
		const harness = makeHarness("bounds");
		const opened = await openAgentHost(
			{ owner: "plan-implement", label: "test", cwd: "/repo", maxAgents: 2 },
			harness.fake.deps(),
		);
		assert.ok(opened.ok);
		const first = await opened.host.start(PLANNER_SPEC);
		assert.ok(first.ok);
		const second = await opened.host.start({ ...PLANNER_SPEC, role: "adversary" });
		assert.ok(second.ok);
		const extra = await opened.host.start({ ...PLANNER_SPEC, role: "extra" });
		assert.equal(extra.ok, false);
		if (!extra.ok) assert.match(extra.error, /at most 2/);
		for (const call of harness.fake.calls) {
			if (call.args[0] === "pane" && (call.args[1] === "split" || call.args[1] === "close")) {
				assert.notEqual(call.args[2], harness.fake.callerPaneId);
			}
		}
		await opened.host.dispose({ closeTab: true });
	});

	it("rejects an invalid startup timeout before splitting a pane", async () => {
		const harness = makeHarness("start-timeout");
		const opened = await openAgentHost({ owner: "o", label: "l", cwd: "/repo", maxAgents: 2 }, harness.fake.deps());
		assert.ok(opened.ok);
		const started = await opened.host.start({ ...PLANNER_SPEC, startupTimeoutMs: 1 });
		assert.equal(started.ok, false);
		if (!started.ok) assert.match(started.error, /startup timeout/);
		assert.equal(harness.fake.callsMatching("pane split").length, 0);
		assert.equal(harness.fake.callsMatching("agent start").length, 0);
	});

	it("maps agent_not_ready to a start failure that names the pane", async () => {
		const harness = makeHarness("not-ready");
		harness.fake.on(
			(args) => args.join(" ").startsWith("agent start"),
			() => ({
				code: 1,
				stdout: "",
				stderr: JSON.stringify({ id: "x", error: { code: "agent_not_ready", message: "pane w5:p101 is not ready" } }),
			}),
		);
		const opened = await openAgentHost({ owner: "o", label: "l", cwd: "/repo", maxAgents: 1 }, harness.fake.deps());
		assert.ok(opened.ok);
		const started = await opened.host.start(PLANNER_SPEC);
		assert.equal(started.ok, false);
		if (!started.ok) assert.match(started.error, /pane w5:p/);
	});

	it("retries agent name conflicts with a fresh suffix", async () => {
		const harness = makeHarness("name-conflict");
		let starts = 0;
		harness.fake.on(
			(args) => args.join(" ").startsWith("agent start"),
			(call) => {
				starts++;
				if (starts === 1) {
					return {
						code: 1,
						stdout: "",
						stderr: JSON.stringify({
							id: "x",
							error: { code: "agent_name_in_use", message: `agent name ${call.args[2]} already in use` },
						}),
					};
				}
				return {
					code: 0,
					stdout: JSON.stringify({
						id: "x",
						result: {
							type: "agent_started",
							agent: agentRecord("idle", harness.fake.rootPaneId, harness.fake.sessionFile),
						},
					}),
					stderr: "",
				};
			},
		);
		const opened = await openAgentHost({ owner: "o", label: "l", cwd: "/repo", maxAgents: 1 }, harness.fake.deps());
		assert.ok(opened.ok);
		const started = await opened.host.start(PLANNER_SPEC);
		assert.ok(started.ok);
		assert.equal(starts, 2);
	});
});

describe("agent-host: ask protocol", () => {
	it("runs the file-based happy path with usage from the session tail", async () => {
		const harness = makeHarness("ask-happy");
		writeFileSync(harness.instructionsFile, "# Instructions\n\nDo the thing.\n");
		harness.fake.appendSession([{ input: 10, output: 1, cost: 0.01 }]); // pre-existing
		harness.fake.onPrompt = (call) => {
			const text = call.args[3] ?? "";
			assert.match(text, new RegExp(harness.instructionsFile.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
			assert.match(text, /DONE /);
			harness.fake.appendSession([
				{ input: 100, output: 20, cost: 0.2 },
				{ input: 30, output: 5, cost: 0.05 },
			]);
			writeFileSync(harness.outputFile, "# Answer\n\nAll done.\n");
		};
		const { agent } = await startOne(harness.fake);
		const result = await agent.ask(askOptions(harness));
		assert.equal(result.status, "completed");
		if (result.status === "completed") {
			assert.match(result.output, /All done\./);
			assert.deepEqual(result.usage, { input: 130, output: 25, cacheRead: 0, cacheWrite: 0, cost: 0.25, turns: 2 });
			assert.equal(result.session, harness.fake.sessionFile);
		}
		// The pointer prompt is short; the plan content never crosses the terminal.
		const prompt = harness.fake.callsMatching("agent prompt")[0];
		assert.ok(prompt);
		assert.ok(Buffer.byteLength(prompt.args[3] ?? "", "utf8") <= POINTER_PROMPT_MAX_BYTES);
		assert.equal(statSync(harness.instructionsFile).mode & 0o777, 0o600);
		assert.equal(statSync(harness.outputFile).mode & 0o777, 0o600);
	});

	it("maps a blocked send to a blocked result without collecting output", async () => {
		const harness = makeHarness("ask-blocked-send");
		harness.fake.promptResponses = [
			{
				code: 1,
				stdout: "",
				stderr: JSON.stringify({ id: "x", error: { code: "agent_blocked", message: "blocked" } }),
			},
		];
		const { agent } = await startOne(harness.fake);
		const result = await agent.ask(askOptions(harness));
		assert.equal(result.status, "blocked");
		if (result.status === "blocked") assert.equal(result.paneId, harness.fake.rootPaneId);
	});

	it("maps a prompt that settles blocked, then resumes to completion", async () => {
		const harness = makeHarness("ask-blocked-settle");
		harness.fake.agentStatus = "blocked";
		harness.fake.onPrompt = () => {
			harness.fake.appendSession([{ input: 11, output: 3, cost: 0.1 }]);
		};
		const { agent } = await startOne(harness.fake);
		const blocked = await agent.ask(askOptions(harness));
		assert.equal(blocked.status, "blocked");
		harness.fake.agentStatus = "idle";
		// The agent finished while blocked: its session grew and the answer landed.
		writeFileSync(harness.outputFile, "resumed answer\n");
		harness.fake.appendSession([{ input: 4, output: 2, cost: 0.01 }]);
		const resumed = await agent.resume({ outputFile: harness.outputFile, timeoutMs: 60_000 });
		assert.equal(resumed.status, "completed");
		if (resumed.status === "completed") {
			assert.equal(resumed.output, "resumed answer\n");
			assert.deepEqual(resumed.usage, { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 });
		}
	});

	it("retries a stalled prompt once after two seconds", async () => {
		const harness = makeHarness("ask-stalled");
		harness.fake.promptResponses = [
			{
				code: 1,
				stdout: "",
				stderr: JSON.stringify({
					id: "x",
					error: { code: "agent_prompt_stalled", message: "no observed change within 5000 ms" },
				}),
			},
			"accept",
		];
		harness.fake.onPrompt = () => writeFileSync(harness.outputFile, "late\n");
		const { agent } = await startOne(harness.fake);
		const result = await agent.ask(askOptions(harness));
		assert.equal(result.status, "completed");
		assert.equal(harness.fake.callsMatching("agent prompt").length, 2);
		assert.deepEqual(harness.fake.sleptMs, [2000]);
	});

	it("fails after two stalled prompts", async () => {
		const harness = makeHarness("ask-stalled-twice");
		const stalled: ExecResponse = {
			code: 1,
			stdout: "",
			stderr: JSON.stringify({ id: "x", error: { code: "agent_prompt_stalled", message: "no observed change" } }),
		};
		harness.fake.promptResponses = [stalled, stalled];
		const { agent } = await startOne(harness.fake);
		const result = await agent.ask(askOptions(harness));
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /stalled/);
	});

	it("aborts with esc and fails when the ask times out", async () => {
		const harness = makeHarness("ask-timeout");
		harness.fake.promptResponses = [
			{
				code: 1,
				stdout: "",
				stderr: JSON.stringify({ id: "x", error: { code: "timeout", message: "timed out after 60000 ms" } }),
			},
		];
		const { agent } = await startOne(harness.fake);
		const result = await agent.ask(askOptions(harness));
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /Timed out after 60s/);
		const keys = harness.fake.callsMatching("agent send-keys").map((call) => call.args[3]);
		assert.deepEqual(keys, ["esc"]);
		assert.equal(harness.fake.callsMatching("agent wait").length >= 1, true);
	});

	it("escalates abort esc → ctrl+c → pane close and is idempotent", async () => {
		const harness = makeHarness("abort-escalate");
		const { agent } = await startOne(harness.fake);
		harness.fake.on(
			(args) => args.join(" ").startsWith("agent wait"),
			() => ({
				code: 1,
				stdout: "",
				stderr: JSON.stringify({ id: "x", error: { code: "timeout", message: "timed out" } }),
			}),
		);
		await agent.abort();
		await agent.abort();
		const keys = harness.fake.callsMatching("agent send-keys").map((call) => call.args[3]);
		assert.deepEqual(keys, ["esc", "ctrl+c", "ctrl+c"]);
		const closes = harness.fake.callsMatching("pane close");
		assert.equal(closes.length, 1);
		assert.equal(closes[0]?.args[2], harness.fake.rootPaneId);
	});

	it("falls back to a DONE pointer from recent terminal output", async () => {
		const harness = makeHarness("ask-fallback");
		const opened = await openAgentHost(
			{ owner: "plan-implement", label: "test", cwd: "/repo", maxAgents: 1 },
			harness.fake.deps(),
		);
		assert.ok(opened.ok);
		const started = await opened.host.start(PLANNER_SPEC);
		assert.ok(started.ok);
		const agent = started.agent;
		// The alternative answer must live under the host's exchange directory.
		const exchangeAlt = join(opened.host.exchangeDir, "alt-answer.md");
		writeFileSync(exchangeAlt, "alternative answer\n");
		harness.fake.readOutput = `Working...\nDONE ${exchangeAlt}\n`;
		const result = await agent.ask(askOptions(harness));
		assert.equal(result.status, "completed");
		if (result.status === "completed") assert.equal(result.output, "alternative answer\n");
	});

	it("fails with a role-labelled error when no output file exists", async () => {
		const harness = makeHarness("ask-no-output");
		harness.fake.readOutput = "the agent forgot to write the file";
		const { agent } = await startOne(harness.fake);
		const result = await agent.ask(askOptions(harness));
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /planner produced no output file/);
	});

	it("truncates oversized output with a marker", async () => {
		const harness = makeHarness("ask-cap");
		harness.fake.onPrompt = () => writeFileSync(harness.outputFile, "x".repeat(400));
		const { agent } = await startOne(harness.fake);
		const result = await agent.ask(askOptions(harness, { outputCapBytes: 100 }));
		assert.equal(result.status, "completed");
		if (result.status === "completed") {
			assert.ok(result.output.length < 200);
			assert.match(result.output, /truncated at 100 bytes/);
		}
	});

	it("rejects a second concurrent ask", async () => {
		const harness = makeHarness("ask-concurrent");
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.fake.on(
			(args) => args.join(" ").startsWith("agent prompt"),
			async () => {
				await gate;
				return { code: 0, stdout: '{"id":"x","result":{"type":"agent_prompted","agent":{}}}', stderr: "" };
			},
		);
		const { agent } = await startOne(harness.fake);
		const first = agent.ask(askOptions(harness));
		await assert.rejects(() => agent.ask(askOptions(harness)), /ask in flight/);
		release?.();
		await first;
	});

	it("rejects pointer prompts over the byte budget without sending", async () => {
		const harness = makeHarness("ask-toolong");
		const longInstructions = join(harness.root, `${"l".repeat(600)}.md`);
		const { agent } = await startOne(harness.fake);
		const result = await agent.ask(askOptions(harness, { promptFile: longInstructions }));
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /pointer prompt exceeds/);
		assert.equal(harness.fake.callsMatching("agent prompt").length, 0);
	});

	it("rejects ask timeouts and output caps outside their bounds", async () => {
		const harness = makeHarness("ask-bounds");
		const { agent } = await startOne(harness.fake);
		const tooShort = await agent.ask(askOptions(harness, { timeoutMs: 1000 }));
		assert.equal(tooShort.status, "failed");
		if (tooShort.status === "failed") assert.match(tooShort.error, /between 1 and 60 minutes/);
		const badCap = await agent.ask(askOptions(harness, { outputCapBytes: 0 }));
		assert.equal(badCap.status, "failed");
		if (badCap.status === "failed") assert.match(badCap.error, /output cap/);
	});
});

describe("agent-host: dispose and exchange directory", () => {
	it("creates a 0700 exchange directory and removes it on dispose", async () => {
		const harness = makeHarness("exchange");
		const { host } = await startOne(harness.fake);
		assert.ok(existsSync(host.exchangeDir));
		assert.equal(statSync(host.exchangeDir).mode & 0o777, 0o700);
		const file = join(host.exchangeDir, "note.md");
		writeFileSync(file, "hi", { mode: 0o600 });
		chmodSync(file, 0o600);
		await host.dispose();
		assert.equal(existsSync(host.exchangeDir), false);
	});

	it("keeps the exchange directory when an ask is still outstanding", async () => {
		const harness = makeHarness("exchange-busy");
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		harness.fake.on(
			(args) => args.join(" ").startsWith("agent prompt"),
			async () => {
				await gate;
				return { code: 0, stdout: '{"id":"x","result":{"type":"agent_prompted","agent":{}}}', stderr: "" };
			},
		);
		const { host, agent } = await startOne(harness.fake);
		const pending = agent.ask(askOptions(harness));
		await host.dispose();
		assert.ok(existsSync(host.exchangeDir));
		release?.();
		await pending;
	});

	it("dispose({closePane:true}) closes only that agent's pane", async () => {
		const harness = makeHarness("dispose-pane");
		const { host, agent } = await startOne(harness.fake);
		await agent.dispose({ closePane: true });
		const closes = harness.fake.callsMatching("pane close");
		assert.deepEqual(
			closes.map((call) => call.args[2]),
			[agent.paneId],
		);
		await host.dispose({ closeTab: true });
		assert.equal(harness.fake.callsMatching("tab close").length, 1);
		assert.equal(harness.fake.callsMatching("tab close")[0]?.args[2], harness.fake.tabId);
	});
});

describe("agent-host helpers", () => {
	it("builds agent names within the herdr name grammar", () => {
		const name = buildAgentName("plan-implement", "implementer", "ab12");
		assert.match(name, /^[a-z][a-z0-9_-]{0,31}$/);
		assert.ok(name.endsWith("-ab12"));
		const long = buildAgentName("a-very-long-owner-name-here", "a-very-long-role-name", "zz99");
		assert.match(long, /^[a-z][a-z0-9_-]{0,31}$/);
		assert.match(buildAgentName("123", "", "0000"), /^[a-z][a-z0-9_-]{0,31}$/);
	});

	it("uses an empty tools allowlist to start Pi without tools", () => {
		const args = hostedAgentArgs({ ...PLANNER_SPEC, tools: [] }, "/tmp/herdr-agent-state.ts");
		assert.ok(args.includes("--no-tools"));
		assert.equal(args.includes("--tools"), false);
	});

	it("keeps instruction content in files via the fixed pointer prompt", () => {
		const text = pointerPrompt("/tmp/x/in.md", "/tmp/x/out.md");
		assert.match(text, /Read and follow the instructions in \/tmp\/x\/in\.md/);
		assert.match(text, /Write your complete final response to \/tmp\/x\/out\.md/);
		assert.match(text, /DONE \/tmp\/x\/out\.md/);
	});

	it("accepts only DONE pointers under the exchange directory", () => {
		assert.equal(extractDonePath("DONE /tmp/exchange/alt.md", "/tmp/exchange"), "/tmp/exchange/alt.md");
		assert.equal(extractDonePath("DONE /etc/passwd", "/tmp/exchange"), undefined);
		assert.equal(extractDonePath("no pointer here", "/tmp/exchange"), undefined);
	});
});

after(() => {
	for (const root of harnessRoots) rmSync(root, { recursive: true, force: true });
});

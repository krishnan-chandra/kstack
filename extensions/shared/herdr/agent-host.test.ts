import assert from "node:assert/strict";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
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
	attachHostedAgent,
	buildAgentName,
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
	cwd: string;
	agent_status: string;
	name: string;
	pane_id: string;
	tab_id: string;
	agent_session: { kind: string; value: string };
}

function agentRecord(status: string, paneId: string, sessionFile: string): AgentFixture {
	return {
		agent: "pi",
		cwd: "/repo",
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
	onPrompt: ((call: ExecCall) => void | Promise<void>) | undefined;
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

	respond(text: string, usage = { input: 0, output: 0, cost: 0 }): void {
		this.appendSession([usage], text);
	}

	appendSession(messages: Array<{ input: number; output: number; cost: number }>, answer?: string): void {
		for (const message of messages) {
			appendFileSync(
				this.sessionFile,
				`${JSON.stringify({
					type: "message",
					message: {
						role: "assistant",
						stopReason: "stop",
						content: [
							{
								type: "text",
								text: `${/KSTACK_RESPONSE [^\n]+/.exec(this.callsMatching("agent prompt").at(-1)?.args[3] ?? "")?.[0]}\n${answer ?? ""}`,
							},
						],
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
			const paneId = args[6] ?? this.rootPaneId;
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
			await this.onPrompt?.(call);
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
		assert.deepEqual(split.args.slice(split.args.indexOf("--cwd"), split.args.indexOf("--cwd") + 2), [
			"--cwd",
			"/repo",
		]);
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
		assert.equal(harness.fake.callsMatching("agent start").length, 1);
		assert.deepEqual(harness.fake.sleptMs, []);
	});

	for (const busyStarts of [1, 100]) {
		it(`bounds shell-readiness retries after ${busyStarts} busy responses`, async () => {
			const harness = makeHarness(`shell-busy-${busyStarts}`);
			let starts = 0;
			harness.fake.on(
				(args) => args.join(" ").startsWith("agent start"),
				() => {
					if (++starts <= busyStarts)
						return {
							code: 1,
							stdout: "",
							stderr: JSON.stringify({ error: { code: "agent_pane_busy", message: "not an available shell" } }),
						};
					return {
						code: 0,
						stderr: "",
						stdout: JSON.stringify({
							result: {
								type: "agent_started",
								agent: agentRecord("idle", harness.fake.rootPaneId, harness.fake.sessionFile),
							},
						}),
					};
				},
			);
			const opened = await openAgentHost({ owner: "o", label: "l", cwd: "/repo", maxAgents: 1 }, harness.fake.deps());
			assert.ok(opened.ok);
			const started = await opened.host.start(PLANNER_SPEC);
			assert.equal(started.ok, busyStarts === 1);
			assert.equal(starts, busyStarts === 1 ? 2 : 4);
			assert.equal(new Set(harness.fake.callsMatching("agent start").map((call) => call.args[2])).size, 1);
			assert.equal(harness.fake.callsMatching("agent prompt").length, 0);
			assert.equal(harness.fake.sleptMs.length, starts - 1);
			await opened.host.dispose({ closeTab: true });
		});
	}

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
			assert.match(text, /KSTACK_RESPONSE /);
			harness.fake.appendSession([{ input: 100, output: 20, cost: 0.2 }]);
			harness.fake.respond("# Answer\n\nAll done.\n", { input: 30, output: 5, cost: 0.05 });
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
		harness.fake.respond("resumed answer\n", { input: 4, output: 2, cost: 0.01 });
		const resumed = await agent.resume();
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
		harness.fake.onPrompt = () => harness.fake.respond("late\n");
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

	it("settles an abort when the unseen tab reports done instead of idle", async () => {
		const harness = makeHarness("abort-done");
		const { agent } = await startOne(harness.fake);
		harness.fake.agentStatus = "working";
		harness.fake.on(
			(args) => args.join(" ").startsWith("agent send-keys"),
			() => {
				// Escape lands; the no-focus host tab is unseen, so herdr reports done, never idle.
				harness.fake.agentStatus = "done";
				return { code: 0, stdout: '{"id":"x","result":{"type":"ok"}}', stderr: "" };
			},
		);
		harness.fake.on(
			(args) => args.join(" ").startsWith("agent wait"),
			(call) => {
				const until = call.args.filter((_arg, index) => call.args[index - 1] === "--until");
				if (!until.includes(harness.fake.agentStatus)) {
					return {
						code: 1,
						stdout: "",
						stderr: JSON.stringify({
							id: "x",
							error: { code: "timeout", message: "timed out waiting for agent status" },
						}),
					};
				}
				return {
					code: 0,
					stderr: "",
					stdout: JSON.stringify({
						id: "x",
						result: {
							type: "agent_info",
							agent: agentRecord(harness.fake.agentStatus, harness.fake.rootPaneId, harness.fake.sessionFile),
						},
					}),
				};
			},
		);
		await agent.abort();
		const keys = harness.fake.callsMatching("agent send-keys").map((call) => call.args[3]);
		assert.deepEqual(keys, ["esc"]);
		assert.equal(harness.fake.callsMatching("pane close").length, 0);
	});

	it("rejects a screen DONE pointer without request-specific session completion", async () => {
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
		assert.equal(result.status, "failed");
		assert.equal(readFileSync(harness.outputFile, "utf8"), "");
	});

	it("fails with a role-labelled error when no output file exists", async () => {
		const harness = makeHarness("ask-no-output");
		harness.fake.readOutput = "the agent forgot to write the file";
		const { agent } = await startOne(harness.fake);
		const result = await agent.ask(askOptions(harness));
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /planner:/);
	});

	it("truncates oversized output with a marker", async () => {
		const harness = makeHarness("ask-cap");
		harness.fake.onPrompt = () => harness.fake.respond("x".repeat(400));
		const { agent } = await startOne(harness.fake);
		const result = await agent.ask(askOptions(harness, { outputCapBytes: 100 }));
		assert.equal(result.status, "completed");
		if (result.status === "completed") {
			assert.ok(result.output.length < 200);
			assert.match(result.output, /truncated at 100 bytes/);
			assert.equal(readFileSync(harness.outputFile, "utf8"), result.output);
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

describe("agent-host review regressions", () => {
	it("attaches a standalone skill to the same response and cancellation lifecycle", async () => {
		const h = makeHarness("attach");
		h.fake.onPrompt = () => h.fake.respond("standalone response");
		const attached = await attachHostedAgent("adversary-test", h.fake.deps());
		assert.ok(attached.ok);
		assert.equal((await attached.agent.ask(askOptions(h))).status, "completed");
		assert.equal(h.fake.callsMatching("tab create").length, 0);
		await attached.agent.dispose();
	});

	it("collects a read-only response through real Pi read and native session persistence", async () => {
		const { createReadTool, SessionManager } = await import("@earendil-works/pi-coding-agent");
		const h = makeHarness("native-response");
		writeFileSync(h.instructionsFile, "ECHO OK");
		const session = SessionManager.create(h.root, join(h.root, "sessions"));
		h.fake.sessionFile = session.getSessionFile() ?? "";
		h.fake.onPrompt = async (call) => {
			const tools = hostedAgentArgs(PLANNER_SPEC, h.fake.integrationPath);
			assert.equal(tools[tools.indexOf("--tools") + 1], "read,grep,find,ls");
			const read = await createReadTool(h.root).execute("read-instructions", { path: h.instructionsFile });
			const answer = read.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
			const marker = /KSTACK_RESPONSE [^\n]+/.exec(call.args[3] ?? "")?.[0];
			session.appendMessage({ role: "user", content: call.args[3] ?? "", timestamp: Date.now() });
			session.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `${marker}\n${answer}` }],
				stopReason: "stop",
				api: "anthropic-messages",
				provider: "fixture",
				model: "fixture",
				timestamp: Date.now(),
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
		};
		const { agent, host } = await startOne(h.fake);
		const result = await agent.ask(askOptions(h));
		assert.equal(result.status, "completed");
		assert.equal(readFileSync(h.outputFile, "utf8"), "ECHO OK");
		await host.dispose();
	});

	it("delivers a rejected-before-send request once after the dialog resolves", async () => {
		const h = makeHarness("blocked-delivery");
		h.fake.promptResponses.push({
			code: 1,
			stdout: "",
			stderr: JSON.stringify({ error: { code: "agent_blocked", message: "dialog" } }),
		});
		h.fake.onPrompt = () => h.fake.respond("delivered");
		const { agent } = await startOne(h.fake);
		assert.equal((await agent.ask(askOptions(h))).status, "blocked");
		assert.equal((await agent.resume()).status, "completed");
		assert.equal(h.fake.callsMatching("agent prompt").length, 2);
		assert.equal(readFileSync(h.outputFile, "utf8"), "delivered");
	});

	it("cancellation wins over a successful prompt envelope and drains before returning", async () => {
		const h = makeHarness("cancel-success");
		const controller = new AbortController();
		h.fake.onPrompt = () => {
			h.fake.respond("too late");
			controller.abort();
		};
		const { agent } = await startOne(h.fake);
		assert.equal((await agent.ask(askOptions(h, { signal: controller.signal }))).status, "aborted");
		assert.equal(h.fake.callsMatching("agent send-keys").length, 1);
		assert.equal(h.fake.callsMatching("agent wait").length, 1);
		assert.equal(readFileSync(h.outputFile, "utf8"), "");
	});

	it("keeps cancellation connected while blocked and resets abort for the next request", async () => {
		const h = makeHarness("cancel-blocked");
		const { agent } = await startOne(h.fake);
		for (let round = 0; round < 2; round++) {
			const controller = new AbortController();
			h.fake.agentStatus = "blocked";
			assert.equal((await agent.ask(askOptions(h, { signal: controller.signal }))).status, "blocked");
			controller.abort();
			h.fake.agentStatus = "idle";
			assert.equal((await agent.resume()).status, "aborted");
		}
		assert.equal(h.fake.callsMatching("agent send-keys").length, 2);
	});

	it("drains a timed-out resume", async () => {
		const h = makeHarness("resume-timeout");
		h.fake.agentStatus = "blocked";
		const { agent } = await startOne(h.fake);
		assert.equal((await agent.ask(askOptions(h))).status, "blocked");
		h.fake.on(
			(args) => args[0] === "agent" && args[1] === "wait" && args.includes("60000"),
			() => ({ code: 1, stdout: "", stderr: JSON.stringify({ error: { code: "timeout", message: "timed out" } }) }),
		);
		h.fake.agentStatus = "idle";
		assert.equal((await agent.resume()).status, "failed");
		assert.equal(h.fake.callsMatching("agent send-keys").length, 1);
	});

	it("rejects partial file output followed by a provider error", async () => {
		const h = makeHarness("provider-error");
		h.fake.onPrompt = () => {
			h.fake.respond("partial");
			writeFileSync(h.outputFile, "partial file");
			appendFileSync(
				h.fake.sessionFile,
				`${JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "error", content: [] } })}\n`,
			);
		};
		const { agent } = await startOne(h.fake);
		const result = await agent.ask(askOptions(h));
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /successful terminal/);
	});

	it("excludes human usage between asks and rejects a session switch during one", async () => {
		const h = makeHarness("usage-windows");
		h.fake.onPrompt = () => h.fake.respond("answer", { input: 1, output: 1, cost: 1 });
		const { agent } = await startOne(h.fake);
		assert.equal((await agent.ask(askOptions(h))).usage.cost, 1);
		h.fake.appendSession([{ input: 100, output: 100, cost: 100 }]);
		assert.equal((await agent.ask(askOptions(h))).usage.cost, 1);
		h.fake.onPrompt = () => {
			h.fake.sessionFile = join(h.root, "switched.jsonl");
			h.fake.respond("wrong session");
		};
		const switched = await agent.ask(askOptions(h));
		assert.equal(switched.status, "failed");
		if (switched.status === "failed") assert.match(switched.error, /session changed/);
	});

	it("refuses to queue a request behind a human turn that is already working", async () => {
		const h = makeHarness("busy-human-turn");
		const { agent } = await startOne(h.fake);
		h.fake.agentStatus = "working";
		const result = await agent.ask(askOptions(h));
		assert.equal(result.status, "failed");
		if (result.status === "failed") assert.match(result.error, /working on another turn/);
		assert.equal(h.fake.callsMatching("agent prompt").length, 0);
		assert.equal(h.fake.callsMatching("agent send-keys").length, 0);
		h.fake.agentStatus = "idle";
		h.fake.onPrompt = () => h.fake.respond("later answer");
		assert.equal((await agent.ask(askOptions(h))).status, "completed");
	});

	it("refuses to prompt when Herdr reports a cwd different from the candidate's assignment", async () => {
		const h = makeHarness("wrong-reported-cwd");
		const opened = await openAgentHost({ owner: "arena", label: "test", cwd: "/repo", maxAgents: 1 }, h.fake.deps());
		assert.ok(opened.ok);
		const started = await opened.host.start({ ...PLANNER_SPEC, cwd: "/candidate" });
		assert.equal(started.ok, false);
		if (!started.ok) assert.match(started.error, /unexpected cwd/);
		assert.equal(h.fake.callsMatching("agent prompt").length, 0);
		await opened.host.dispose();
	});

	it("allocates the first different cwd and never reuses a failed startup pane", async () => {
		const h = makeHarness("first-cwd");
		const opened = await openAgentHost({ owner: "arena", label: "test", cwd: "/repo", maxAgents: 2 }, h.fake.deps());
		assert.ok(opened.ok);
		h.fake.on(
			(args) => args[0] === "agent" && args[1] === "start",
			() => ({
				code: 1,
				stdout: "",
				stderr: JSON.stringify({ error: { code: "agent_not_ready", message: "startup failed" } }),
			}),
		);
		await opened.host.start({ ...PLANNER_SPEC, cwd: "/candidate-a" });
		await opened.host.start({ ...PLANNER_SPEC, cwd: "/candidate-b" });
		const splits = h.fake.callsMatching("pane split");
		assert.equal(splits[0]?.args.at(-3), "--cwd");
		assert.ok(splits[0]?.args.includes("/candidate-a"));
		const starts = h.fake.callsMatching("agent start");
		assert.notEqual(starts[0]?.args[6], starts[1]?.args[6]);
		await opened.host.dispose();
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
		const text = pointerPrompt("/tmp/x/in.md", "request-id");
		assert.match(text, /Read and follow the instructions in \/tmp\/x\/in\.md/);
		assert.match(text, /KSTACK_RESPONSE request-id/);
		assert.match(text, /do not write an answer file/);
	});
});

after(() => {
	for (const root of harnessRoots) rmSync(root, { recursive: true, force: true });
});

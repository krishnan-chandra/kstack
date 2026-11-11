/** Shared host-lifecycle contract suite run identically against Herdr and Rex. */

import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { type HostDeps, openAgentHost, openPaneHost } from "./agent-host.ts";
import { readHostedAgentState, writeHostedAgentState } from "./agent-state.ts";
import { connectTerminal } from "./backends.ts";
import { virtualClock } from "./clock.ts";
import { attachHostedAgent } from "./hosted-agent.ts";
import { FakeRex, type FakeRexBlock } from "./rex/test-helpers.ts";
import type { AgentRef, BackendExec, BackendKind } from "./terminal-backend.ts";

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type PromptScenario =
	| "complete"
	| "blocked-before-send"
	| "blocked-after-send"
	| "stall-once"
	| "timeout"
	| "switch-session"
	| "drift-cwd";

interface ContractWorld {
	readonly kind: BackendKind;
	readonly root: string;
	readonly callerPaneId: string;
	readonly instructionsFile: string;
	readonly outputFile: string;
	deps(overrides?: Partial<HostDeps>): HostDeps;
	setPromptScenario(scenario: PromptScenario, answerText?: string): void;
	unblockAgent(paneId: string, answerText?: string): void;
	setAbortSettles(settles: boolean): void;
	keysSentTo(paneId: string): string[][];
	closedPanes(): string[];
	createExternalAgent(name: string): AgentRef;
	abortOnStartLaunch(controller: AbortController): void;
}

function appendCompletedTurn(sessionFile: string, promptText: string, answer: string, cost = 0.05): void {
	const marker = /KSTACK_RESPONSE [^\n]+/.exec(promptText)?.[0] ?? "KSTACK_RESPONSE missing";
	appendFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "message",
			message: {
				role: "assistant",
				stopReason: "stop",
				content: [{ type: "text", text: `${marker}\n${answer}` }],
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
			},
		})}\n`,
	);
}

function createHerdrWorld(): ContractWorld {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kstack-contract-herdr-")));
	roots.push(root);
	mkdirSync(join(root, "extensions"), { recursive: true });
	writeFileSync(join(root, "extensions", "herdr-agent-state.ts"), "// integration\n");
	const instructionsFile = join(root, "instructions.md");
	const outputFile = join(root, "output.md");
	writeFileSync(instructionsFile, "Follow instructions.\n", { mode: 0o600 });

	const callerPaneId = "w1:pCaller";
	const paneTabs = new Map<string, string>([[callerPaneId, "w1:tCaller"]]);
	const agents = new Map<string, { paneId: string; tabId: string; cwd: string; status: string; sessionFile: string }>();
	const keysByPane = new Map<string, string[][]>();
	const closed: string[] = [];
	let nextId = 10;
	let scenario: PromptScenario = "complete";
	let scenarioAnswer = "contract ok\n";
	let stallRemaining = 0;
	const lastPromptByPane = new Map<string, string>();
	let abortSettles = false;
	let abortControllerOnLaunch: AbortController | undefined;

	const recordKey = (paneId: string, keys: string[]) => {
		const list = keysByPane.get(paneId) ?? [];
		list.push(keys);
		keysByPane.set(paneId, list);
	};

	const exec: BackendExec = async (args) => {
		const command = `${args[0] ?? ""} ${args[1] ?? ""}`;
		if (command === "status server") return { code: 0, stdout: "running\n", stderr: "" };
		if (command === "tab create") {
			const tabId = `w1:t${nextId++}`;
			const paneId = `w1:p${nextId++}`;
			paneTabs.set(paneId, tabId);
			return {
				code: 0,
				stdout: JSON.stringify({
					result: { type: "tab_created", tab: { tab_id: tabId }, root_pane: { pane_id: paneId } },
				}),
				stderr: "",
			};
		}
		if (command === "pane layout") {
			const paneId = args[3] ?? "";
			const tabId = paneTabs.get(paneId);
			if (!tabId) {
				return {
					code: 1,
					stdout: "",
					stderr: JSON.stringify({ error: { code: "pane_not_found", message: "missing" } }),
				};
			}
			return {
				code: 0,
				stdout: JSON.stringify({
					result: { type: "pane_layout", layout: { area: { width: 240, height: 60 }, tab_id: tabId } },
				}),
				stderr: "",
			};
		}
		if (command === "pane split") {
			const anchor = args[2] ?? "";
			const tabId = paneTabs.get(anchor) ?? "w1:tCaller";
			const paneId = `w1:p${nextId++}`;
			paneTabs.set(paneId, tabId);
			return {
				code: 0,
				stdout: JSON.stringify({
					result: { type: "pane_info", pane: { pane_id: paneId, tab_id: tabId, agent_status: "unknown" } },
				}),
				stderr: "",
			};
		}
		if (command === "pane close") {
			const paneId = args[2] ?? "";
			closed.push(paneId);
			paneTabs.delete(paneId);
			for (const [name, agent] of agents) if (agent.paneId === paneId) agents.delete(name);
			return { code: 0, stdout: '{"result":{"type":"ok"}}', stderr: "" };
		}
		if (command === "tab close") {
			return { code: 0, stdout: '{"result":{"type":"ok"}}', stderr: "" };
		}
		if (command === "agent start") {
			const name = args[2] ?? "";
			const paneId = args[6] ?? "";
			if (abortControllerOnLaunch) {
				abortControllerOnLaunch.abort();
				return {
					code: 1,
					stdout: "",
					stderr: JSON.stringify({ error: { code: "agent_not_ready", message: "cancelled startup" } }),
				};
			}
			const sessionFile = join(root, `${name}.jsonl`);
			writeFileSync(sessionFile, "");
			const tabId = paneTabs.get(paneId) ?? "w1:tCaller";
			const entry = { paneId, tabId, cwd: root, status: "idle", sessionFile };
			agents.set(name, entry);
			return {
				code: 0,
				stdout: JSON.stringify({
					result: {
						type: "agent_started",
						agent: {
							name,
							pane_id: paneId,
							tab_id: tabId,
							cwd: entry.cwd,
							agent_status: entry.status,
							agent_session: { kind: "path", value: sessionFile },
						},
					},
				}),
				stderr: "",
			};
		}
		if (command === "agent get") {
			const name = args[2] ?? "";
			const entry = agents.get(name);
			if (!entry) {
				return {
					code: 1,
					stdout: "",
					stderr: JSON.stringify({ error: { code: "agent_not_found", message: "not found" } }),
				};
			}
			return {
				code: 0,
				stdout: JSON.stringify({
					result: {
						type: "agent_info",
						agent: {
							name,
							pane_id: entry.paneId,
							tab_id: entry.tabId,
							cwd: entry.cwd,
							agent_status: entry.status,
							agent_session: { kind: "path", value: entry.sessionFile },
						},
					},
				}),
				stderr: "",
			};
		}
		if (command === "agent prompt") {
			const name = args[2] ?? "";
			const text = args[3] ?? "";
			const entry = agents.get(name)!;
			lastPromptByPane.set(entry.paneId, text);
			if (scenario === "blocked-before-send") {
				scenario = "complete";
				return {
					code: 1,
					stdout: "",
					stderr: JSON.stringify({ error: { code: "agent_blocked", message: "dialog open" } }),
				};
			}
			if (scenario === "blocked-after-send") {
				entry.status = "blocked";
			} else if (scenario === "stall-once" && stallRemaining > 0) {
				stallRemaining--;
				return {
					code: 1,
					stdout: "",
					stderr: JSON.stringify({ error: { code: "agent_prompt_stalled", message: "stalled" } }),
				};
			} else if (scenario === "timeout") {
				return {
					code: 1,
					stdout: "",
					stderr: JSON.stringify({ error: { code: "timeout", message: "timed out" } }),
				};
			} else if (scenario === "switch-session") {
				const switched = join(root, `${name}-switched.jsonl`);
				writeFileSync(switched, "");
				entry.sessionFile = switched;
				appendCompletedTurn(switched, text, scenarioAnswer);
				entry.status = "done";
			} else if (scenario === "drift-cwd") {
				entry.cwd = join(root, "other-cwd");
				appendCompletedTurn(entry.sessionFile, text, scenarioAnswer);
				entry.status = "done";
			} else {
				appendCompletedTurn(entry.sessionFile, text, scenarioAnswer);
				entry.status = "done";
			}
			return {
				code: 0,
				stdout: JSON.stringify({
					result: {
						type: "agent_prompted",
						agent: {
							name,
							pane_id: entry.paneId,
							tab_id: entry.tabId,
							cwd: entry.cwd,
							agent_status: entry.status,
							agent_session: { kind: "path", value: entry.sessionFile },
						},
					},
				}),
				stderr: "",
			};
		}
		if (command === "agent send-keys") {
			const name = args[2] ?? "";
			const entry = agents.get(name);
			if (entry) {
				recordKey(entry.paneId, args.slice(3));
				if (abortSettles) entry.status = "done";
			}
			return { code: 0, stdout: '{"result":{"type":"ok"}}', stderr: "" };
		}
		if (command === "agent wait") {
			const name = args[2] ?? "";
			const entry = agents.get(name);
			if (!entry) {
				return {
					code: 1,
					stdout: "",
					stderr: JSON.stringify({ error: { code: "agent_not_found", message: "not found" } }),
				};
			}
			if (!abortSettles && (scenario === "timeout" || entry.status === "working")) {
				return {
					code: 1,
					stdout: "",
					stderr: JSON.stringify({ error: { code: "timeout", message: "timed out" } }),
				};
			}
			return {
				code: 0,
				stdout: JSON.stringify({
					result: {
						type: "agent_info",
						agent: {
							name,
							pane_id: entry.paneId,
							tab_id: entry.tabId,
							cwd: entry.cwd,
							agent_status: entry.status,
							agent_session: { kind: "path", value: entry.sessionFile },
						},
					},
				}),
				stderr: "",
			};
		}
		throw new Error(`Unhandled Herdr contract command: ${args.join(" ")}`);
	};

	return {
		kind: "herdr",
		root,
		callerPaneId,
		instructionsFile,
		outputFile,
		deps(overrides = {}) {
			return {
				exec,
				env: {
					HERDR_ENV: "1",
					HERDR_WORKSPACE_ID: "w1",
					HERDR_PANE_ID: callerPaneId,
					PI_CODING_AGENT_DIR: root,
				},
				clock: virtualClock(),
				...overrides,
			};
		},
		setPromptScenario(next, answerText = "contract ok\n") {
			scenario = next;
			scenarioAnswer = answerText;
			stallRemaining = next === "stall-once" ? 1 : 0;
			for (const entry of agents.values()) {
				entry.status = next === "blocked-before-send" ? "blocked" : "idle";
			}
		},
		unblockAgent(paneId, answerText) {
			for (const entry of agents.values()) {
				if (entry.paneId === paneId) {
					entry.status = "idle";
					if (answerText !== undefined) {
						const lastPrompt = lastPromptByPane.get(paneId) ?? "";
						if (lastPrompt) appendCompletedTurn(entry.sessionFile, lastPrompt, answerText);
					}
				}
			}
		},
		setAbortSettles(settles) {
			abortSettles = settles;
			if (!settles) {
				for (const entry of agents.values()) entry.status = "working";
			}
		},
		keysSentTo(paneId) {
			return keysByPane.get(paneId) ?? [];
		},
		closedPanes() {
			return [...closed];
		},
		createExternalAgent(name) {
			const paneId = `w1:pExt${nextId++}`;
			paneTabs.set(paneId, "w1:tCaller");
			const sessionFile = join(root, `${name}.jsonl`);
			writeFileSync(sessionFile, "");
			agents.set(name, { paneId, tabId: "w1:tCaller", cwd: root, status: "idle", sessionFile });
			return { name, paneId };
		},
		abortOnStartLaunch(controller) {
			abortControllerOnLaunch = controller;
		},
	};
}

function createRexWorld(): ContractWorld {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "kstack-contract-rex-")));
	roots.push(root);
	const instructionsFile = join(root, "instructions.md");
	const outputFile = join(root, "output.md");
	writeFileSync(instructionsFile, "Follow instructions.\n", { mode: 0o600 });

	const rex = new FakeRex(root, { sessionId: "session:contract" });
	const deliveredPrompt = new Map<FakeRexBlock, string>();
	let scenario: PromptScenario = "complete";
	let scenarioAnswer = "contract ok\n";
	let stallRemaining = 0;
	let abortSettles = false;
	let abortControllerOnLaunch: AbortController | undefined;
	const agentBlocks = () =>
		[...rex.blocks.values()].filter((block) => block !== rex.block(rex.callerBlock) && block.piState);
	const settle = (block: FakeRexBlock, state: string) => {
		block.piState = state;
		block.updatedAt = rex.nextTimestamp();
	};

	rex.onEnter = (_blockId, input, block) => {
		const trimmed = input.trim();
		if (trimmed.endsWith(".launch'")) {
			if (abortControllerOnLaunch) abortControllerOnLaunch.abort();
			else rex.runLauncher(block, trimmed.slice(1, -1));
			return;
		}
		const PASTE_START = "\u001b[200~";
		const PASTE_END = "\u001b[201~";
		const unwrapped = input.startsWith(PASTE_START) ? input.slice(PASTE_START.length, -PASTE_END.length) : input;
		const promptText = unwrapped || deliveredPrompt.get(block) || "";
		if (promptText) {
			deliveredPrompt.set(block, promptText);
			block.captureText = promptText;
		}
		if (scenario === "stall-once" && stallRemaining > 0) {
			// The text stays in Pi's editor and the status never advances.
			stallRemaining--;
			return;
		}
		if (scenario === "timeout") return settle(block, "working");
		if (scenario === "blocked-after-send") return settle(block, "blocked");
		if (scenario === "switch-session" && block.stateFile) {
			const switched = join(root, `switched-${rex.nextTimestamp()}.jsonl`);
			writeFileSync(switched, "");
			block.sessionFile = switched;
			settle(block, "done");
			const previous = readHostedAgentState(block.stateFile);
			if (previous)
				writeHostedAgentState(block.stateFile, { ...previous, sessionFile: switched, updatedAt: block.updatedAt });
			appendCompletedTurn(switched, promptText, scenarioAnswer);
			return;
		}
		if (scenario === "drift-cwd") block.cwd = join(root, "other-cwd");
		if (block.sessionFile) appendCompletedTurn(block.sessionFile, promptText, scenarioAnswer);
		settle(block, "done");
	};
	rex.onKeys = (_blockId, _keys, block) => {
		if (abortSettles) settle(block, "idle");
	};

	return {
		kind: "rex",
		root,
		callerPaneId: rex.callerBlock,
		instructionsFile,
		outputFile,
		deps(overrides = {}) {
			return {
				exec: rex.exec,
				env: rex.env,
				clock: virtualClock(),
				resolvePiBinary: () => "/usr/local/bin/pi",
				...overrides,
			};
		},
		setPromptScenario(next, answerText = "contract ok\n") {
			scenario = next;
			scenarioAnswer = answerText;
			stallRemaining = next === "stall-once" ? 1 : 0;
			for (const block of agentBlocks()) {
				if (next === "blocked-before-send") settle(block, "blocked");
				else block.piState = "idle";
			}
		},
		unblockAgent(paneId, answerText) {
			const block = rex.block(paneId);
			const prompt = deliveredPrompt.get(block);
			if (answerText !== undefined && block.sessionFile && prompt) {
				appendCompletedTurn(block.sessionFile, prompt, answerText);
			}
			scenario = "complete";
			settle(block, "done");
		},
		setAbortSettles(settles) {
			abortSettles = settles;
			if (!settles) for (const block of agentBlocks()) settle(block, "working");
		},
		keysSentTo(paneId) {
			return rex.keysSentTo(paneId).map((keys) => keys.map((key) => (key === "escape" ? "esc" : key)));
		},
		closedPanes() {
			return [...rex.closed];
		},
		createExternalAgent(name) {
			const block = rex.addAgentBlock(name);
			return { name, paneId: rex.blockIdOf(block), ...(block.stateFile ? { stateFile: block.stateFile } : undefined) };
		},
		abortOnStartLaunch(controller) {
			abortControllerOnLaunch = controller;
		},
	};
}

const WORLDS: ReadonlyArray<readonly [BackendKind, () => ContractWorld]> = [
	["herdr", createHerdrWorld],
	["rex", createRexWorld],
];

for (const [kind, makeWorld] of WORLDS) {
	describe(`TerminalBackend contract (${kind})`, () => {
		it("starts, asks, and completes with validated output and usage", async () => {
			const world = makeWorld();
			world.setPromptScenario("complete", "Hello from hosted agent\n");
			const opened = await openAgentHost({ owner: "swarm", label: "run", cwd: world.root, maxAgents: 1 }, world.deps());
			assert.ok(opened.ok, opened.ok ? "" : opened.error);
			assert.equal(opened.host.backend, world.kind);
			const started = await opened.host.start({ role: "worker", model: "p/m", cwd: world.root });
			assert.ok(started.ok, started.ok ? "" : started.error);
			const result = await started.agent.ask({
				promptFile: world.instructionsFile,
				outputFile: world.outputFile,
				timeoutMs: 60_000,
			});
			assert.equal(result.status, "completed");
			if (result.status === "completed") {
				assert.equal(result.output, "Hello from hosted agent\n");
				assert.equal(readFileSync(world.outputFile, "utf8"), "Hello from hosted agent\n");
				assert.equal(result.usage.turns, 1);
			}
			await opened.host.dispose({ closeTab: true });
		});

		it("handles blocked-before-send and blocked-after-send then resumes to completion", async () => {
			const world = makeWorld();
			const opened = await openAgentHost({ owner: "swarm", label: "run", cwd: world.root, maxAgents: 1 }, world.deps());
			assert.ok(opened.ok);
			const started = await opened.host.start({ role: "worker", model: "p/m", cwd: world.root });
			assert.ok(started.ok);

			// 1. Blocked before send: resume delivers the stored prompt once unblocked.
			world.setPromptScenario("blocked-before-send", "after pre-send unblock\n");
			const blockedPre = await started.agent.ask({
				promptFile: world.instructionsFile,
				outputFile: world.outputFile,
				timeoutMs: 60_000,
			});
			assert.equal(blockedPre.status, "blocked");
			world.unblockAgent(started.agent.paneId);
			const resumedPre = await started.agent.resume();
			assert.equal(resumedPre.status, "completed");
			if (resumedPre.status === "completed") {
				assert.equal(resumedPre.output, "after pre-send unblock\n");
			}

			// 2. Blocked after send: resume waits for settlement and collects the answer.
			world.setPromptScenario("blocked-after-send");
			const blockedPost = await started.agent.ask({
				promptFile: world.instructionsFile,
				outputFile: world.outputFile,
				timeoutMs: 60_000,
			});
			assert.equal(blockedPost.status, "blocked");
			world.unblockAgent(started.agent.paneId, "after post-send unblock\n");
			const resumedPost = await started.agent.resume();
			assert.equal(resumedPost.status, "completed");
			if (resumedPost.status === "completed") {
				assert.equal(resumedPost.output, "after post-send unblock\n");
			}
			await opened.host.dispose();
		});

		it("retries a stalled prompt once and succeeds", async () => {
			const world = makeWorld();
			const opened = await openAgentHost({ owner: "swarm", label: "run", cwd: world.root, maxAgents: 1 }, world.deps());
			assert.ok(opened.ok);
			const started = await opened.host.start({ role: "worker", model: "p/m", cwd: world.root });
			assert.ok(started.ok);
			world.setPromptScenario("stall-once", "recovered after stall\n");

			const result = await started.agent.ask({
				promptFile: world.instructionsFile,
				outputFile: world.outputFile,
				timeoutMs: 60_000,
			});
			assert.equal(result.status, "completed");
			if (result.status === "completed") {
				assert.equal(result.output, "recovered after stall\n");
			}
			await opened.host.dispose();
		});

		it("fails with a timeout error and aborts when the request exceeds timeoutMs", async () => {
			const world = makeWorld();
			const opened = await openAgentHost({ owner: "swarm", label: "run", cwd: world.root, maxAgents: 1 }, world.deps());
			assert.ok(opened.ok);
			const started = await opened.host.start({ role: "worker", model: "p/m", cwd: world.root });
			assert.ok(started.ok);
			world.setPromptScenario("timeout");
			world.setAbortSettles(true);

			const result = await started.agent.ask({
				promptFile: world.instructionsFile,
				outputFile: world.outputFile,
				timeoutMs: 60_000,
			});
			assert.equal(result.status, "failed");
			if (result.status === "failed") assert.match(result.error, /Timed out after 60s/);
			assert.equal(world.keysSentTo(started.agent.paneId).length >= 1, true);
			await opened.host.dispose();
		});

		it("escalates owned aborts (esc → ctrl+c×2 → close) and sends Escape-only to attached seats", async () => {
			const world = makeWorld();
			const opened = await openAgentHost({ owner: "swarm", label: "run", cwd: world.root, maxAgents: 1 }, world.deps());
			assert.ok(opened.ok);
			const started = await opened.host.start({ role: "worker", model: "p/m", cwd: world.root });
			assert.ok(started.ok);
			world.setAbortSettles(false);

			await started.agent.abort();
			const ownedKeys = world.keysSentTo(started.agent.paneId);
			assert.deepEqual(ownedKeys, [["esc"], ["ctrl+c", "ctrl+c"]]);
			assert.ok(world.closedPanes().includes(started.agent.paneId));
			assert.equal(world.closedPanes().includes(world.callerPaneId), false);
			assert.deepEqual(world.keysSentTo(world.callerPaneId), []);

			const externalRef = world.createExternalAgent("council-seat-a");
			world.setAbortSettles(false);
			const connected = await connectTerminal(world.deps());
			assert.ok(connected.ok, connected.ok ? "" : connected.error);
			const attached = await attachHostedAgent(externalRef, connected.session);
			assert.ok(attached.ok, attached.ok ? "" : attached.error);
			await attached.agent.abort();
			assert.deepEqual(world.keysSentTo(externalRef.paneId), [["esc"]]);
			assert.equal(world.closedPanes().includes(externalRef.paneId), false);
			assert.deepEqual(world.keysSentTo(world.callerPaneId), []);
			await attached.agent.dispose();
			await opened.host.dispose();
		});

		it("fails closed when the hosted session switches mid-request", async () => {
			const world = makeWorld();
			const opened = await openAgentHost({ owner: "swarm", label: "run", cwd: world.root, maxAgents: 1 }, world.deps());
			assert.ok(opened.ok);
			const started = await opened.host.start({ role: "worker", model: "p/m", cwd: world.root });
			assert.ok(started.ok);
			world.setPromptScenario("switch-session");
			world.setAbortSettles(true);

			const result = await started.agent.ask({
				promptFile: world.instructionsFile,
				outputFile: world.outputFile,
				timeoutMs: 60_000,
			});
			assert.equal(result.status, "failed");
			if (result.status === "failed") assert.match(result.error, /session changed/i);
			await opened.host.dispose();
		});

		it("fails closed when the hosted cwd drifts mid-request", async () => {
			const world = makeWorld();
			const opened = await openAgentHost({ owner: "swarm", label: "run", cwd: world.root, maxAgents: 1 }, world.deps());
			assert.ok(opened.ok);
			const started = await opened.host.start({ role: "worker", model: "p/m", cwd: world.root });
			assert.ok(started.ok);
			world.setPromptScenario("drift-cwd");
			world.setAbortSettles(true);

			const result = await started.agent.ask({
				promptFile: world.instructionsFile,
				outputFile: world.outputFile,
				timeoutMs: 60_000,
			});
			assert.equal(result.status, "failed");
			if (result.status === "failed") assert.match(result.error, /cwd changed/i);
			await opened.host.dispose();
		});

		it("closes its allocated pane when a start is cancelled", async () => {
			const world = makeWorld();
			const opened = await openPaneHost(
				{ owner: "council", label: "cancel", cwd: world.root, maxAgents: 1, direction: "right" },
				world.deps(),
			);
			assert.ok(opened.ok);
			const controller = new AbortController();
			world.abortOnStartLaunch(controller);

			const started = await opened.host.start({
				role: "seat-a",
				model: "p/m",
				cwd: world.root,
				signal: controller.signal,
			});
			assert.equal(started.ok, false);
			if (!started.ok) {
				assert.equal(started.aborted, true);
				assert.ok(started.paneId);
				assert.ok(world.closedPanes().includes(started.paneId));
			}
			assert.equal(world.closedPanes().includes(world.callerPaneId), false);
			await opened.host.dispose();
		});
	});
}

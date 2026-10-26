import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type AgentHost,
	type AskOptions,
	type AskResult,
	type HostedAgent,
	type HostedAgentSpec,
	preflightHerdr,
} from "../shared/herdr/agent-host.ts";
import planImplementExtension from "./index.ts";

const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 };
const validPlan =
	"Delivery: single-pr\n\n## Ordered implementation steps\n1. [STEP-1] Make the change.\n\n## Acceptance criteria\n- [AC-1] Tests pass.\n";

class FakeAgent implements HostedAgent {
	readonly name = "plan-planner-abcd";
	readonly role = "planner";
	readonly paneId = "w1:p1";
	readonly tabId = "w1:t1";
	readonly sessionFile: string | undefined = "/sessions/planner.jsonl";
	private readonly result: AskResult;

	constructor(result: AskResult) {
		this.result = result;
	}

	async ask(_options: AskOptions): Promise<AskResult> {
		return this.result;
	}

	async resume(): Promise<AskResult> {
		return this.result;
	}

	async abort(): Promise<void> {}
	async dispose(): Promise<void> {}
}

class FakeHost implements AgentHost {
	readonly tabId = "w1:t1";
	readonly exchangeDir: string;
	readonly disposeArgs: Array<{ closeTab?: boolean } | undefined> = [];
	readonly roles: string[] = [];
	private readonly result: AskResult;

	constructor(root: string, result: AskResult) {
		this.exchangeDir = join(root, "exchange");
		this.result = result;
		mkdirSync(this.exchangeDir);
	}

	async start(spec: HostedAgentSpec) {
		this.roles.push(spec.role);
		const output =
			spec.role === "adversary"
				? "Verdict: approve\n\n## Blocking\nNone.\n\n## Suggestions\nNone.\n"
				: "## Execution Ledger\n- [STEP-1] Make the change. — done\n- [AC-1] Tests pass. — done\n";
		const result = spec.role === "planner" ? this.result : { status: "completed" as const, output, usage };
		return { ok: true as const, agent: new FakeAgent(result) };
	}

	async dispose(options?: { closeTab?: boolean }): Promise<void> {
		this.disposeArgs.push(options);
	}
}

interface Harness {
	host: FakeHost;
	notices: string[];
	cwd: string;
	hostOpened(): number;
	activity: { execCreated: number; preflightCalls: number; modelChecks: number; vcsCalls: number };
	run(): Promise<void>;
	shutdown(): void;
}

function createHarness(
	t: TestContext,
	result: AskResult,
	confirm: () => Promise<boolean>,
	args = "--plan-only --no-adversary --change-kind feature Test retention",
	beforeHostReturn?: () => void,
	options: { mode?: ExtensionCommandContext["mode"]; herdrEnv?: string | null; review?: boolean } = {},
): Harness {
	const root = mkdtempSync(join(tmpdir(), "kstack-plan-orchestration-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	writeFileSync(
		join(agentDir, "kstack.json"),
		JSON.stringify({
			"plan-implement": {
				planner: { model: "test/planner", thinking: "high" },
				implementer: { model: "test/implementer", thinking: "medium" },
				timeoutMinutes: 1,
			},
			council: options.review ? { seats: [{ model: "test/adversary", thinking: "medium" }] } : undefined,
			vcs: { backend: "git", stackProvider: "none" },
		}),
	);
	const integrationDir = join(agentDir, "extensions");
	mkdirSync(integrationDir);
	writeFileSync(join(integrationDir, "herdr-agent-state.ts"), "// fixture\n");
	const activity = { execCreated: 0, preflightCalls: 0, modelChecks: 0, vcsCalls: 0 };
	let head = "a".repeat(40);
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	});

	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const listeners = new Map<string, () => void>();
	const piHost: Partial<ExtensionAPI> = {
		on(name, listener) {
			listeners.set(name, () => {
				/* SAFETY: The lifecycle listeners exercised here accept no required runtime data. */
				void (listener as () => void)();
			});
			return () => {};
		},
		registerCommand(_name, value) {
			command = value;
		},
		registerShortcut() {},
		registerMessageRenderer() {},
		getCommands: () => [],
		getSessionName: () => undefined,
		setSessionName() {},
		sendMessage() {},
		events: { on: () => () => {}, emit() {} },
		exec: async (_command, argv) => {
			activity.vcsCalls++;
			let stdout = "";
			if (argv.includes("--show-toplevel")) stdout = root;
			else if (argv[0] === "rev-parse") stdout = head;
			else if (argv[0] === "branch") stdout = "kstack/test-retention";
			else if (argv[0] === "switch") head = "b".repeat(40);
			return { code: argv[0] === "show-ref" ? 1 : 0, stdout, stderr: "", killed: false };
		},
	};
	const host = new FakeHost(root, result);
	let hostOpened = 0;
	planImplementExtension(
		/* SAFETY: This host supplies every Pi capability used by the exercised command path. */ piHost as ExtensionAPI,
		{
			createExec: () => {
				activity.execCreated++;
				return async () => ({ code: 0, stdout: "", stderr: "" });
			},
			preflight: async ({ exec }) => {
				activity.preflightCalls++;
				return preflightHerdr({
					exec,
					env: {
						PI_CODING_AGENT_DIR: agentDir,
						HERDR_ENV: options.herdrEnv === null ? undefined : (options.herdrEnv ?? "1"),
						HERDR_WORKSPACE_ID: "w1",
						HERDR_PANE_ID: "w1:p0",
					},
				});
			},
			openPane: async () => {
				hostOpened++;
				beforeHostReturn?.();
				return { ok: true, host };
			},
		},
	);
	const registeredCommand = command;
	assert.ok(registeredCommand);
	const notices: string[] = [];
	const commandContext =
		/* SAFETY: The assigned fixture supplies every Pi capability used by the exercised command path. */ {} as ExtensionCommandContext;
	Object.assign(commandContext, {
		cwd: root,
		mode: options.mode ?? "tui",
		hasUI: true,
		ui: {
			confirm,
			notify: (message: string) => notices.push(message),
			setStatus() {},
			select: async () => {
				throw new Error("unexpected select");
			},
			editor: async () => {
				throw new Error("unexpected editor");
			},
		},
		waitForIdle: async () => {},
		getSystemPromptOptions: () => ({
			skills: options.review
				? ["write-pr", "find-reviewers"].map((name) => ({
						name,
						filePath: `/skills/${name}/SKILL.md`,
						baseDir: `/skills/${name}`,
						source: "test",
					}))
				: [],
		}),
		modelRegistry: {
			find: () => {
				activity.modelChecks++;
				return {};
			},
			hasConfiguredAuth: () => true,
			getRegisteredProviderIds: () => [],
		},
		signal: new AbortController().signal,
	});
	return {
		host,
		notices,
		cwd: root,
		activity,
		hostOpened: () => hostOpened,
		run: () => registeredCommand.handler(args, commandContext),
		shutdown: () => {
			const listener = listeners.get("session_shutdown");
			assert.ok(listener);
			listener();
		},
	};
}

describe("plan-implement environment gate", { concurrency: false }, () => {
	it("refuses non-TUI before host, preflight, VCS or model work", async (t) => {
		const harness = createHarness(
			t,
			{ status: "completed", output: validPlan, usage },
			async () => true,
			undefined,
			undefined,
			{ mode: "json" },
		);
		await harness.run();
		assert.equal(harness.hostOpened(), 0);
		assert.deepEqual(harness.activity, { execCreated: 0, preflightCalls: 0, modelChecks: 0, vcsCalls: 0 });
		assert.match(harness.notices.join("\n"), /requires interactive TUI/);
	});

	for (const herdrEnv of [null, "0"]) {
		it(`refuses failed real Herdr preflight (${JSON.stringify(herdrEnv)}) before review or model work`, async (t) => {
			const harness = createHarness(
				t,
				{ status: "completed", output: validPlan, usage },
				async () => true,
				undefined,
				undefined,
				{ herdrEnv },
			);
			await harness.run();
			assert.equal(harness.hostOpened(), 0);
			assert.deepEqual(harness.host.roles, []);
			assert.deepEqual(harness.activity, { execCreated: 1, preflightCalls: 1, modelChecks: 0, vcsCalls: 0 });
			assert.match(harness.notices.join("\n"), /Herdr is required/);
		});
	}

	it("runs hosted implementation review after successful real Herdr preflight", async (t) => {
		const previous = process.env.HERDR_ENV;
		delete process.env.HERDR_ENV;
		try {
			const harness = createHarness(
				t,
				{ status: "completed", output: validPlan, usage },
				async () => true,
				"--plan-file approved.md --change-kind refactor Test retention",
				undefined,
				{ review: true },
			);
			writeFileSync(join(harness.cwd, "approved.md"), validPlan);
			await harness.run();
			assert.equal(harness.activity.preflightCalls, 1);
			assert.equal(harness.hostOpened(), 2, harness.notices.join("\n"));
			assert.ok(harness.host.roles.includes("adversary"), harness.notices.join("\n"));
			assert.match(harness.notices.join("\n"), /Adversarial review approved/);
		} finally {
			if (previous === undefined) delete process.env.HERDR_ENV;
			else process.env.HERDR_ENV = previous;
		}
	});
});

describe("plan-implement host retention", () => {
	it("closes the tab when confirmation is declined", async (t) => {
		const harness = createHarness(t, { status: "completed", output: validPlan, usage }, async () => false);
		await harness.run();
		assert.deepEqual(harness.host.disposeArgs, [{ closeTab: true }]);
	});

	it("closes the tab when the session becomes stale during confirmation", async (t) => {
		let release: (() => void) | undefined;
		let entered: (() => void) | undefined;
		const confirmationEntered = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const confirmationReleased = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = createHarness(t, { status: "completed", output: validPlan, usage }, async () => {
			entered?.();
			await confirmationReleased;
			return true;
		});
		const running = harness.run();
		await confirmationEntered;
		harness.shutdown();
		release?.();
		await running;
		assert.deepEqual(harness.host.disposeArgs, [{ closeTab: true }]);
	});

	it("closes a late-acquired host without touching stale UI", async (t) => {
		let confirmations = 0;
		const harness = createHarness(
			t,
			{ status: "completed", output: validPlan, usage },
			async () => {
				confirmations++;
				return true;
			},
			undefined,
			() => harness.shutdown(),
		);
		await harness.run();
		assert.equal(confirmations, 0);
		assert.deepEqual(harness.host.disposeArgs, [{ closeTab: true }]);
	});

	it("closes the owned panes when confirmation throws", async (t) => {
		const harness = createHarness(t, { status: "completed", output: validPlan, usage }, async () => {
			throw new Error("UI unavailable");
		});
		await assert.rejects(harness.run(), /UI unavailable/);
		assert.deepEqual(harness.host.disposeArgs, [{ closeTab: true }]);
	});

	it("retains the tab after a failed workflow", async (t) => {
		const harness = createHarness(t, { status: "failed", error: "boom", usage }, async () => true);
		await harness.run();
		assert.deepEqual(harness.host.disposeArgs, [undefined]);
		assert.ok(harness.notices.some((message) => /retained in Herdr tab/.test(message)));
	});

	it("retains the tab after a successful plan-only workflow", async (t) => {
		const harness = createHarness(t, { status: "completed", output: validPlan, usage }, async () => true);
		await harness.run();
		assert.deepEqual(harness.host.disposeArgs, [undefined]);
		assert.ok(harness.notices.some((message) => /retained in Herdr tab/.test(message)));
	});

	it("rejects an unreadable supplied plan before opening the host", async (t) => {
		const harness = createHarness(
			t,
			{ status: "completed", output: validPlan, usage },
			async () => true,
			"--plan-file missing.md --no-adversary --change-kind feature Implement it",
		);
		await harness.run();
		assert.equal(harness.hostOpened(), 0);
		assert.deepEqual(harness.host.disposeArgs, []);
		assert.ok(harness.notices.some((message) => /Cannot open plan file/.test(message)));
	});

	it("rejects a supplied plan with no acceptance criteria before opening the host", async (t) => {
		const harness = createHarness(
			t,
			{ status: "completed", output: validPlan, usage },
			async () => true,
			"--plan-file incomplete.md --no-adversary --change-kind feature Implement it",
		);
		writeFileSync(join(harness.cwd, "incomplete.md"), "## Ordered implementation steps\n1. [STEP-1] Do it.\n");
		await harness.run();
		assert.equal(harness.hostOpened(), 0);
		assert.ok(harness.notices.some((message) => /no acceptance criteria/.test(message)));
	});
});

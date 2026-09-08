import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentHost, AskOptions, AskResult, HostedAgent, HostedAgentSpec } from "../shared/herdr/agent-host.ts";
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
	private readonly result: AskResult;

	constructor(root: string, result: AskResult) {
		this.exchangeDir = join(root, "exchange");
		this.result = result;
		mkdirSync(this.exchangeDir);
	}

	async start(_spec: HostedAgentSpec) {
		return { ok: true as const, agent: new FakeAgent(this.result) };
	}

	async dispose(options?: { closeTab?: boolean }): Promise<void> {
		this.disposeArgs.push(options);
	}
}

interface Harness {
	host: FakeHost;
	notices: string[];
	run(): Promise<void>;
	shutdown(): void;
}

function createHarness(t: TestContext, result: AskResult, confirm: () => Promise<boolean>): Harness {
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
			vcs: { backend: "git", stackProvider: "none" },
		}),
	);
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
		},
		registerCommand(_name, value) {
			command = value;
		},
		registerShortcut() {},
		registerMessageRenderer() {},
		getCommands: () => [
			{
				name: "panel-review",
				source: "extension",
				sourceInfo: { path: "test", source: "test", scope: "temporary", origin: "top-level" },
			},
		],
		getSessionName: () => undefined,
		setSessionName() {},
		sendMessage() {},
		events: { on: () => () => {}, emit() {} },
		exec: async () => ({ code: 0, stdout: `${root}\n`, stderr: "", killed: false }),
	};
	const host = new FakeHost(root, result);
	planImplementExtension(
		/* SAFETY: This host supplies every Pi capability used by the exercised command path. */ piHost as ExtensionAPI,
		{
			createExec: () => async () => ({ code: 0, stdout: "", stderr: "" }),
			preflight: async () => ({
				ok: true,
				integrationPath: join(agentDir, "extensions", "herdr-agent-state.ts"),
				workspaceId: "w1",
				callerPane: "w1:p0",
			}),
			openHost: async () => ({ ok: true, host }),
		},
	);
	const registeredCommand = command;
	assert.ok(registeredCommand);
	const notices: string[] = [];
	const commandContext =
		/* SAFETY: The assigned fixture supplies every Pi capability used by the exercised command path. */ {} as ExtensionCommandContext;
	Object.assign(commandContext, {
		cwd: root,
		mode: "tui",
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
		getSystemPromptOptions: () => ({ skills: [] }),
		modelRegistry: {
			find: () => ({}),
			hasConfiguredAuth: () => true,
			getRegisteredProviderIds: () => [],
		},
		signal: new AbortController().signal,
	});
	return {
		host,
		notices,
		run: () =>
			registeredCommand.handler("--plan-only --no-adversary --change-kind feature Test retention", commandContext),
		shutdown: () => {
			const listener = listeners.get("session_shutdown");
			assert.ok(listener);
			listener();
		},
	};
}

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
});

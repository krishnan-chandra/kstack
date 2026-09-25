import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import {
	type AgentSession,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { isString } from "../shared/validation.ts";

const HANDOFF_EXTENSION = resolve(import.meta.dirname, "index.ts");

/**
 * Start a real Pi runtime whose process tool allowlist is `tools`, persist one
 * completed turn, and run `/handoff <args>`. Only sendUserMessage is
 * suppressed; runtime creation, extension loading, tool registration, command
 * dispatch, model selection, thinking selection, and persistence are Pi's
 * production implementations, so no provider call is made.
 */
async function runSmokeHandoff(t: TestContext, tools: string[], args: string) {
	const root = await mkdtemp(join(tmpdir(), "kstack-handoff-smoke-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionDir = join(agentDir, "sessions", "--project--");
	await Promise.all([
		mkdir(cwd, { recursive: true }),
		mkdir(agentDir, { recursive: true }),
		mkdir(sessionDir, { recursive: true }),
	]);

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	let runtime: AgentSessionRuntime | undefined;
	t.after(async () => {
		await runtime?.dispose();
		if (previousAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		}
		await rm(root, { recursive: true, force: true });
	});

	// Load the predecessor and replacement through distinct entry modules. Pi
	// supports isolated extension module graphs, so replacement coordination
	// cannot depend on one module-scoped variable surviving the switch.
	const handoffUrl = pathToFileURL(HANDOFF_EXTENSION).href;
	const predecessorExtension = join(root, "handoff-predecessor.ts");
	const replacementExtension = join(root, "handoff-replacement.ts");
	await Promise.all([
		writeFile(predecessorExtension, `export { default } from ${JSON.stringify(`${handoffUrl}?predecessor`)};\n`),
		writeFile(replacementExtension, `export { default } from ${JSON.stringify(`${handoffUrl}?replacement`)};\n`),
	]);

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	await modelRuntime.setRuntimeApiKey("openai", "smoke-test-key");
	await modelRuntime.setRuntimeApiKey("openrouter", "smoke-test-key");

	const parentModel = modelRuntime.getModel("openrouter", "openai/gpt-5.6-sol");
	const targetModel = modelRuntime.getModel("openai", "gpt-5.6-terra");
	assert.ok(parentModel, "smoke test requires the built-in openrouter/openai/gpt-5.6-sol model");
	assert.ok(targetModel, "smoke test requires the built-in openai/gpt-5.6-terra model");

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
		const extensionPath = options.sessionStartEvent?.reason === "new" ? replacementExtension : predecessorExtension;
		const services = await createAgentSessionServices({
			cwd: options.cwd,
			agentDir,
			modelRuntime,
			settingsManager,
			resourceLoaderOptions: { additionalExtensionPaths: [extensionPath] },
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager: options.sessionManager,
				sessionStartEvent: options.sessionStartEvent,
				model: parentModel,
				thinkingLevel: "low",
				tools,
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};

	const sourceManager = SessionManager.create(cwd, sessionDir);
	runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: sourceManager,
	});

	const notifications: Array<{ message: string; level: string | undefined }> = [];
	const submittedPrompts: string[] = [];
	const bindSession = async (session: AgentSession): Promise<void> => {
		const ui = session.extensionRunner.getUIContext();
		ui.editor = async (_title, prefill) => prefill;
		ui.notify = (message, level) => notifications.push({ message, level });
		ui.setEditorText = (text) => submittedPrompts.push(text);
		await session.bindExtensions({
			mode: "tui",
			uiContext: ui,
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: (options) => {
					if (!runtime) throw new Error("runtime is not initialized");
					return runtime.newSession({
						...options,
						withSession: async (fresh) => {
							const sendUserMessage = fresh.sendUserMessage;
							fresh.sendUserMessage = async (content) => {
								submittedPrompts.push(isString(content) ? content : "[multimodal prompt]");
							};
							try {
								await options?.withSession?.(fresh);
							} finally {
								fresh.sendUserMessage = sendUserMessage;
							}
						},
					});
				},
				fork: async () => {
					throw new Error("fork is outside this smoke test");
				},
				navigateTree: async () => {
					throw new Error("tree navigation is outside this smoke test");
				},
				switchSession: async () => {
					throw new Error("session switching is outside this smoke test");
				},
				reload: async () => {
					throw new Error("reload is outside this smoke test");
				},
			},
		});
	};

	runtime.setRebindSession(bindSession);
	await bindSession(runtime.session);
	// Pi intentionally delays creating a new session file until it has an
	// assistant response. Seed one completed turn so handoff sees the same durable
	// source artifact as an interactive session.
	runtime.session.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "source session is ready" }],
		api: parentModel.api,
		provider: parentModel.provider,
		model: parentModel.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	runtime.session.sessionManager.appendSessionInfo("handoff-smoke-source");
	const sourceFile = runtime.session.sessionFile;
	assert.ok(sourceFile, "source session must be persisted");
	const sourceBefore = await readFile(sourceFile, "utf8");

	const command = runtime.session.extensionRunner.getCommand("handoff");
	assert.ok(command, "handoff command must be registered");
	await command.handler(args, runtime.session.extensionRunner.createCommandContext());
	return { session: runtime.session, notifications, submittedPrompts, sourceFile, sourceBefore };
}

test("handoff applies an explicit model across isolated replacement module graphs", async (t) => {
	const smoke = await runSmokeHandoff(
		t,
		["read_handoff_history", "search_handoff_history"],
		"--model openai/gpt-5.6-terra:medium continue the smoke test",
	);
	const { session, notifications, submittedPrompts, sourceFile, sourceBefore } = smoke;

	assert.equal(`${session.model?.provider}/${session.model?.id}`, "openai/gpt-5.6-terra");
	assert.equal(session.thinkingLevel, "medium");
	assert.equal(submittedPrompts.length, 1);
	assert.match(submittedPrompts[0], /Continue work from the previous Pi session/);
	assert.match(submittedPrompts[0], /^1\. Call read_handoff_history first, with no arguments\./mu);
	assert.match(submittedPrompts[0], /^3\. Use search_handoff_history/mu);
	assert.ok(notifications.some(({ message }) => message.includes("Model: openai/gpt-5.6-terra:medium")));

	const replacementEntries = session.sessionManager.getEntries();
	assert.ok(
		replacementEntries.some((entry) => entry.type === "custom_message" && entry.customType === "handoff"),
		"replacement transcript must retain handoff provenance",
	);
	assert.ok(
		replacementEntries.some(
			(entry) => entry.type === "model_change" && entry.provider === "openai" && entry.modelId === "gpt-5.6-terra",
		),
		"replacement transcript must record the selected model",
	);
	assert.ok(
		replacementEntries.some((entry) => entry.type === "thinking_level_change" && entry.thinkingLevel === "medium"),
		"replacement transcript must record the selected thinking level",
	);
	assert.equal(await readFile(sourceFile, "utf8"), sourceBefore, "handoff must not mutate the predecessor transcript");
});

test("handoff points a replacement without handoff tools at the transcript under a real allowlist", async (t) => {
	const { session, notifications, submittedPrompts, sourceFile } = await runSmokeHandoff(
		t,
		["read", "grep"],
		"review the diff",
	);

	assert.equal(submittedPrompts.length, 1);
	assert.ok(submittedPrompts[0].includes(`read the transcript JSONL at ${sourceFile} with read and grep.`));
	assert.ok(!submittedPrompts[0].includes("Call read_handoff_history"));
	assert.ok(notifications.some(({ level, message }) => level === "warning" && message.includes("transcript file")));
	assert.deepEqual(session.getActiveToolNames().sort(), ["grep", "read"]);
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
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

const HANDOFF_EXTENSION = resolve(import.meta.dirname, "index.ts");

/**
 * Exercise the real Pi replacement lifecycle without making a provider call.
 * Only sendUserMessage is suppressed; runtime creation, extension loading,
 * command dispatch, model selection, thinking selection, and persistence are
 * Pi's production implementations.
 */
test("handoff applies an explicit model across isolated replacement module graphs", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "kstack-handoff-smoke-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "sessions");
	await Promise.all([
		mkdir(cwd, { recursive: true }),
		mkdir(agentDir, { recursive: true }),
		mkdir(sessionDir, { recursive: true }),
	]);

	let runtime: AgentSessionRuntime | undefined;
	t.after(async () => {
		await runtime?.dispose();
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
				noTools: "all",
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
								submittedPrompts.push(typeof content === "string" ? content : "[multimodal prompt]");
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
	await command.handler(
		"--model openai/gpt-5.6-terra:medium continue the smoke test",
		runtime.session.extensionRunner.createCommandContext(),
	);

	assert.equal(`${runtime.session.model?.provider}/${runtime.session.model?.id}`, "openai/gpt-5.6-terra");
	assert.equal(runtime.session.thinkingLevel, "medium");
	assert.equal(submittedPrompts.length, 1);
	assert.match(submittedPrompts[0], /Continue work from the previous Pi session/);
	assert.ok(notifications.some(({ message }) => message.includes("Model: openai/gpt-5.6-terra:medium")));

	const replacementEntries = runtime.session.sessionManager.getEntries();
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

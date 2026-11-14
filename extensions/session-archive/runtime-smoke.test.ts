import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
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
import { getArchiveDbPath, getArchiveRoot } from "./archive-files.ts";
import { getSessionRow, openArchiveDbReadOnly, searchArchive } from "./archive-store.ts";

const SESSION_ARCHIVE_EXTENSION = resolve(import.meta.dirname, "index.ts");

test("archive_session tool archives the current session standalone via agent_settled and starts a fresh empty session", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "kstack-archive-tool-smoke-"));
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

	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
	});
	await modelRuntime.setRuntimeApiKey("openrouter", "smoke-test-key");
	const model = modelRuntime.getModel("openrouter", "openai/gpt-5.6-sol");
	assert.ok(model, "smoke test requires the built-in openrouter/openai/gpt-5.6-sol model");

	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
		retry: { enabled: false },
	});
	const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
		const services = await createAgentSessionServices({
			cwd: options.cwd,
			agentDir,
			modelRuntime,
			settingsManager,
			resourceLoaderOptions: { additionalExtensionPaths: [SESSION_ARCHIVE_EXTENSION] },
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager: options.sessionManager,
				sessionStartEvent: options.sessionStartEvent,
				model,
				thinkingLevel: "low",
				tools: ["archive_session", "search_session_archive", "read_session_archive"],
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

	const bindSession = async (session: AgentSession): Promise<void> => {
		await session.bindExtensions({
			mode: "print",
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: (options) => {
					if (!runtime) throw new Error("runtime is not initialized");
					return runtime.newSession(options);
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

	const streamFn = () => {
		const stream = createAssistantMessageEventStream();
		const msg = fauxAssistantMessage([fauxToolCall("archive_session", {})]);
		queueMicrotask(() => {
			stream.push({ type: "start", partial: msg });
			stream.push({ type: "done", reason: "toolUse", message: msg });
			stream.end(msg);
		});
		return stream;
	};
	runtime.session.agent.streamFunction = streamFn;

	const sourceSessionId = runtime.session.sessionId;
	const sourceSessionFile = runtime.session.sessionFile;
	assert.ok(sourceSessionFile, "source session must have a file path");

	await runtime.session.prompt("Unique marker archive-smoke-needle: please archive this session standalone.");

	assert.notEqual(runtime.session.sessionId, sourceSessionId, "runtime must have replaced the archived session");
	assert.equal(runtime.session.state.messages.length, 0, "replacement session must start empty");
	assert.equal(existsSync(sourceSessionFile), false, "source session file must be moved out of active dir");

	const archiveRoot = getArchiveRoot();
	const db = openArchiveDbReadOnly(getArchiveDbPath(archiveRoot));
	try {
		const row = getSessionRow(db, sourceSessionId);
		assert.equal(row?.state, "archived");
		assert.ok(row?.archive_path && existsSync(row.archive_path), "archived JSONL artifact must exist");
		if (process.platform !== "win32") {
			const mode = (await stat(row.archive_path)).mode & 0o777;
			assert.equal(mode, 0o444);
		}
		const hits = searchArchive(db, { query: '"archive-smoke-needle"' });
		assert.equal(hits.length, 1);
		assert.equal(hits[0].session_id, sourceSessionId);
	} finally {
		db.close();
	}
});

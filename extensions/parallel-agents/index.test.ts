import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentPaneHost } from "../shared/agent-pane.ts";
import { nestedUsage, registerParallelAgents } from "./index.ts";

type Registration = Parameters<typeof registerParallelAgents>[0];
type RegisteredTool = Parameters<Registration["registerTool"]>[0];

const session = { kind: "missing", reason: "not-reported" } as const;

function context(
	value: Pick<ExtensionContext, "cwd"> &
		Partial<Omit<ExtensionContext, "cwd" | "ui">> & { ui?: Partial<ExtensionContext["ui"]> },
): ExtensionContext {
	return /* SAFETY: Validation exits before these tests access omitted context capabilities. */ value as ExtensionContext;
}

function createTool(handlers = new Map<string, () => void>()): RegisteredTool {
	let tool: RegisteredTool | undefined;
	const paneHost: AgentPaneHost = {
		startRun() {
			throw new Error("Validation tests must not start an agent pane.");
		},
		resetSession() {},
	};
	registerParallelAgents({
		paneHost,
		registerTool(value) {
			tool = value;
		},
		onShutdown(handler) {
			handlers.set("session_shutdown", handler);
		},
	});
	assert.ok(tool);
	return tool;
}

describe("parallel-agents extension", () => {
	it("registers the model-callable tool and shutdown cleanup", () => {
		const handlers = new Map<string, () => void>();
		const tool = createTool(handlers);
		assert.equal(tool.name, "parallel_agents");
		assert.ok(handlers.has("session_shutdown"));
	});

	it("rejects a writable Arena task in the current repository before spawning", async () => {
		const tool = createTool();
		const root = mkdtempSync(join(tmpdir(), "parallel-agents-test-"));
		await assert.rejects(
			tool.execute(
				"call",
				{
					kind: "arena",
					tasks: [{ label: "a", model: "model/a", prompt: "work", access: "workspace", cwd: root }],
				},
				undefined,
				undefined,
				context({ cwd: root }),
			),
			/Writable Arena tasks cannot use or contain the current repository root/,
		);
	});

	it("rejects nested writable Arena directories before confirmation", async () => {
		const tool = createTool();
		const root = mkdtempSync(join(tmpdir(), "parallel-agents-test-"));
		const workspace = mkdtempSync(join(tmpdir(), "parallel-agents-workspace-"));
		const nestedWorkspace = join(workspace, "nested");
		mkdirSync(nestedWorkspace);
		await assert.rejects(
			tool.execute(
				"call",
				{
					kind: "arena",
					tasks: [
						{ label: "a", model: "model/a", prompt: "work", access: "workspace", cwd: workspace },
						{ label: "b", model: "model/b", prompt: "work", access: "workspace", cwd: nestedWorkspace },
					],
				},
				undefined,
				undefined,
				context({ cwd: root }),
			),
			/Writable Arena tasks must use non-overlapping directories/,
		);
	});

	it("rejects duplicate writable Arena directories", async () => {
		const tool = createTool();
		const root = mkdtempSync(join(tmpdir(), "parallel-agents-test-"));
		const workspace = mkdtempSync(join(tmpdir(), "parallel-agents-workspace-"));
		await assert.rejects(
			tool.execute(
				"call",
				{
					kind: "arena",
					tasks: [
						{ label: "a", model: "model/a", prompt: "work", access: "workspace", cwd: workspace },
						{ label: "b", model: "model/b", prompt: "work", access: "workspace", cwd: workspace },
					],
				},
				undefined,
				undefined,
				context({ cwd: root }),
			),
			/Writable Arena tasks must use non-overlapping directories/,
		);
	});

	it("allows sibling writable Arena directories to reach confirmation", async () => {
		const tool = createTool();
		const root = mkdtempSync(join(tmpdir(), "parallel-agents-test-"));
		const workspaces = mkdtempSync(join(tmpdir(), "parallel-agents-workspaces-"));
		const firstWorkspace = join(workspaces, "first");
		const secondWorkspace = join(workspaces, "second");
		mkdirSync(firstWorkspace);
		mkdirSync(secondWorkspace);
		await assert.rejects(
			tool.execute(
				"call",
				{
					kind: "arena",
					tasks: [
						{ label: "a", model: "model/a", prompt: "work", access: "workspace", cwd: firstWorkspace },
						{ label: "b", model: "model/b", prompt: "work", access: "workspace", cwd: secondWorkspace },
					],
				},
				undefined,
				undefined,
				context({ cwd: root, hasUI: true, ui: { confirm: async () => false } }),
			),
			/Writable Arena candidates were not approved/,
		);
	});

	it("rejects a writable Arena directory that contains the current repository", async () => {
		const tool = createTool();
		const workspace = mkdtempSync(join(tmpdir(), "parallel-agents-workspace-"));
		const root = join(workspace, "repository");
		mkdirSync(root);
		await assert.rejects(
			tool.execute(
				"call",
				{
					kind: "arena",
					tasks: [{ label: "a", model: "model/a", prompt: "work", access: "workspace", cwd: workspace }],
				},
				undefined,
				undefined,
				context({ cwd: root }),
			),
			/Writable Arena tasks cannot use or contain the current repository root/,
		);
	});

	it("rejects a writable Arena directory inside the current repository", async () => {
		const tool = createTool();
		const root = mkdtempSync(join(tmpdir(), "parallel-agents-test-"));
		const workspace = join(root, "workspace");
		mkdirSync(workspace);
		await assert.rejects(
			tool.execute(
				"call",
				{
					kind: "arena",
					tasks: [{ label: "a", model: "model/a", prompt: "work", access: "workspace", cwd: workspace }],
				},
				undefined,
				undefined,
				context({ cwd: root }),
			),
			/Writable Arena tasks cannot be inside the current repository root/,
		);
	});

	it("discloses that writable Arena directories are not enforced boundaries", async () => {
		const tool = createTool();
		const root = mkdtempSync(join(tmpdir(), "parallel-agents-test-"));
		const workspace = mkdtempSync(join(tmpdir(), "parallel-agents-workspace-"));
		let confirmation = "";
		await assert.rejects(
			tool.execute(
				"call",
				{
					kind: "arena",
					tasks: [{ label: "a", model: "model/a", prompt: "work", access: "workspace", cwd: workspace }],
				},
				undefined,
				undefined,
				context({
					cwd: root,
					hasUI: true,
					ui: {
						confirm: async (_title: string, body: string) => {
							confirmation = body;
							return false;
						},
					},
				}),
			),
			/Writable Arena candidates were not approved/,
		);
		assert.match(confirmation, /full user permissions/);
		assert.match(confirmation, /not an enforced boundary/);
	});

	it("aggregates nested child usage for Pi session accounting", () => {
		const usage = nestedUsage([
			{
				status: "completed",
				label: "a",
				model: "model/a",
				output: "a",
				usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, cost: 0.4, turns: 1 },
				session,
			},
			{
				status: "failed",
				label: "b",
				model: "model/b",
				error: "boom",
				usage: { input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.1, turns: 1 },
				session,
			},
		]);
		assert.deepEqual(usage, {
			input: 15,
			output: 3,
			cacheRead: 3,
			cacheWrite: 1,
			totalTokens: 22,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
		});
	});
});

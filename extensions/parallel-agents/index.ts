import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentPaneHost, type AgentPaneRun, getAgentPaneHost } from "../shared/agent-pane.ts";
import { runParallelAgents } from "./orchestrator.ts";
import type { ParallelAgentKind, ParallelAgentsDetails, ParallelAgentTask } from "./types.ts";

const MAX_TASKS = 8;
const DEFAULT_CONCURRENCY = 4;

function isSameOrDescendant(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function nestedUsage(results: ParallelAgentsDetails["results"]): Usage {
	const usage = results.reduce(
		(total, result) => ({
			input: total.input + result.usage.input,
			output: total.output + result.usage.output,
			cacheRead: total.cacheRead + result.usage.cacheRead,
			cacheWrite: total.cacheWrite + result.usage.cacheWrite,
			cost: total.cost + result.usage.cost,
		}),
		{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
	);
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
	};
}

const TaskSchema = Type.Object({
	label: Type.String({ minLength: 1, maxLength: 16, pattern: "^[A-Za-z0-9_-]+$" }),
	model: Type.String({ minLength: 3, description: "Pi model id in provider/model[:thinking] form" }),
	prompt: Type.String({ minLength: 1, maxLength: 512 * 1024 }),
	access: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("workspace")])),
	cwd: Type.Optional(Type.String({ minLength: 1 })),
});

const ParametersSchema = Type.Object({
	kind: Type.Union([Type.Literal("simplify"), Type.Literal("arena")]),
	tasks: Type.Array(TaskSchema, { minItems: 1, maxItems: MAX_TASKS }),
	maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TASKS })),
});

type ParallelAgentsTool = ToolDefinition<typeof ParametersSchema, ParallelAgentsDetails>;

interface ParallelAgentsRegistration {
	paneHost: AgentPaneHost;
	registerTool(tool: ParallelAgentsTool): void;
	onShutdown(handler: () => void): void;
}

export function registerParallelAgents(registration: ParallelAgentsRegistration): void {
	let activeController: AbortController | undefined;
	const { paneHost } = registration;

	registration.registerTool({
		name: "parallel_agents",
		label: "Parallel agents",
		description:
			"Run isolated Pi agents with a live TUI dashboard. Use only for the simplify and arena skills. Simplify tasks must stay read-only. Arena workspace tasks must use separate pre-created worktrees or directories and never share a writable directory. Children have no extensions, skills, prompt templates, or context files. Prompts are sent over stdin. Returns each final report in input order. Max 8 tasks and 4 concurrent by default.",
		promptSnippet: "Run visible isolated parallel agents for simplify and arena workflows",
		promptGuidelines: [
			"Use parallel_agents instead of manually spawning background Pi processes when the simplify or arena skill calls for parallel agents.",
		],
		parameters: ParametersSchema,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (activeController) throw new Error("Another parallel_agents run is already active.");
			const kind: ParallelAgentKind = params.kind;
			const labels = new Set<string>();
			const writableDirs = new Set<string>();
			const root = realpathSync(ctx.cwd);
			const tasks: ParallelAgentTask[] = params.tasks.map((task) => ({
				...task,
				access: task.access ?? "read-only",
				cwd: realpathSync(resolve(ctx.cwd, task.cwd ?? ".")),
			}));
			for (const task of tasks) {
				if (labels.has(task.label)) throw new Error(`Duplicate task label: ${task.label}`);
				labels.add(task.label);
				if (kind === "simplify" && task.access !== "read-only") {
					throw new Error("Simplify tasks must use read-only access.");
				}
				if (task.access === "workspace") {
					if (isSameOrDescendant(task.cwd, root)) {
						throw new Error("Writable Arena tasks cannot use or contain the current repository root.");
					}
					if (isSameOrDescendant(root, task.cwd)) {
						throw new Error("Writable Arena tasks cannot be inside the current repository root.");
					}
					for (const existing of writableDirs) {
						if (isSameOrDescendant(existing, task.cwd) || isSameOrDescendant(task.cwd, existing)) {
							throw new Error(
								`Writable Arena tasks must use non-overlapping directories: ${task.cwd} overlaps ${existing}`,
							);
						}
					}
					writableDirs.add(task.cwd);
				}
			}
			if (writableDirs.size > 0) {
				if (!ctx.hasUI) throw new Error("Writable Arena tasks require interactive confirmation.");
				const confirmed = await ctx.ui.confirm(
					"Run writable Arena candidates?",
					`Each child runs with your full user permissions. Its assigned directory is its working directory by convention, not an enforced boundary:\n${[...writableDirs].map((dir) => `- ${dir}`).join("\n")}`,
				);
				if (!confirmed) throw new Error("Writable Arena candidates were not approved.");
			}
			const controller = new AbortController();
			activeController = controller;
			const abort = () => controller.abort();
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
			let pane: AgentPaneRun | undefined;
			if (ctx.mode === "tui") {
				pane = paneHost.startRun({
					ctx,
					title: kind === "simplify" ? "Simplify" : "Arena",
					clearPreviewOnComplete: true,
					onAbort: abort,
				});
				for (const task of tasks) pane.addChild({ id: task.label, label: task.label, model: task.model });
			} else {
				ctx.ui.setStatus("parallel-agents", `${kind}: running ${tasks.length} agent(s)`);
			}
			try {
				const results = await runParallelAgents({
					kind,
					tasks,
					maxConcurrency: params.maxConcurrency ?? DEFAULT_CONCURRENCY,
					signal: controller.signal,
					deps: { pane },
				});
				const completed = results.filter((result) => result.status === "completed").length;
				const failed = results.filter((result) => result.status === "failed").length;
				const aborted = results.filter((result) => result.status === "aborted").length;
				const reports = results.map((result) => {
					if (result.status === "completed") return `## ${result.label} — completed\n\n${result.output}`;
					if (result.status === "failed") return `## ${result.label} — failed\n\n${result.error}`;
					return `## ${result.label} — aborted`;
				});
				const details: ParallelAgentsDetails = { kind, results };
				return {
					content: [
						{
							type: "text" as const,
							text: `${kind}: ${completed}/${results.length} completed, ${failed} failed, ${aborted} aborted\n\n${reports.join("\n\n---\n\n")}`,
						},
					],
					details,
					usage: nestedUsage(results),
				};
			} finally {
				signal?.removeEventListener("abort", abort);
				pane?.dispose();
				ctx.ui.setStatus("parallel-agents", undefined);
				if (activeController === controller) activeController = undefined;
			}
		},
	});

	registration.onShutdown(() => {
		activeController?.abort();
		activeController = undefined;
	});
}

export default function parallelAgentsExtension(pi: ExtensionAPI): void {
	registerParallelAgents({
		paneHost: getAgentPaneHost(pi),
		registerTool: (tool) => pi.registerTool(tool),
		onShutdown: (handler) => pi.on("session_shutdown", handler),
	});
}

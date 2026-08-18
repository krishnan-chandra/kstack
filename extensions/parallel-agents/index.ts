import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { mountLiveDashboard } from "../shared/live-dashboard.ts";
import { ParallelAgentsDashboardStore } from "./live-dashboard.ts";
import { runParallelAgents } from "./orchestrator.ts";
import type { ParallelAgentKind, ParallelAgentsDetails, ParallelAgentTask } from "./types.ts";

const MAX_TASKS = 8;
const DEFAULT_CONCURRENCY = 4;

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

export default function parallelAgentsExtension(pi: ExtensionAPI): void {
	let activeController: AbortController | undefined;
	let disposeDashboard: (() => void) | undefined;

	pi.registerTool({
		name: "parallel_agents",
		label: "Parallel agents",
		description:
			"Run isolated Pi agents with a live TUI dashboard. Use only for the simplify and arena skills. Simplify tasks must stay read-only. Arena workspace tasks must use separate pre-created worktrees or directories and never share a writable directory. Children have no extensions, skills, prompt templates, or context files. Prompts are sent over stdin. Returns each final report in input order. Max 8 tasks and 4 concurrent by default.",
		promptSnippet: "Run visible isolated parallel agents for simplify and arena workflows",
		promptGuidelines: [
			"Use parallel_agents instead of manually spawning background Pi processes when the simplify or arena skill calls for parallel agents.",
		],
		parameters: Type.Object({
			kind: Type.Union([Type.Literal("simplify"), Type.Literal("arena")]),
			tasks: Type.Array(TaskSchema, { minItems: 1, maxItems: MAX_TASKS }),
			maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TASKS })),
		}),
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
					if (task.cwd === root) throw new Error("Writable Arena tasks cannot use the current repository root.");
					if (writableDirs.has(task.cwd))
						throw new Error(`Writable Arena tasks must use distinct directories: ${task.cwd}`);
					writableDirs.add(task.cwd);
				}
			}
			if (writableDirs.size > 0) {
				if (!ctx.hasUI) throw new Error("Writable Arena tasks require interactive confirmation.");
				const confirmed = await ctx.ui.confirm(
					"Run writable Arena candidates?",
					`Each child can edit and run commands only from its assigned directory:\n${[...writableDirs].map((dir) => `- ${dir}`).join("\n")}`,
				);
				if (!confirmed) throw new Error("Writable Arena candidates were not approved.");
			}
			const controller = new AbortController();
			activeController = controller;
			const abort = () => controller.abort();
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
			const dashboard = ctx.mode === "tui" ? new ParallelAgentsDashboardStore(kind) : undefined;
			if (dashboard) {
				for (const task of tasks) dashboard.addAgent(task.label, task.label, task.model);
				disposeDashboard = mountLiveDashboard(ctx.ui, "parallel-agents", dashboard, {
					stripTerminalSequences,
					truncateToWidth: (text, width) => truncateToWidth(text, width),
				});
			} else {
				ctx.ui.setStatus("parallel-agents", `${kind}: running ${tasks.length} agent(s)`);
			}
			try {
				const results = await runParallelAgents({
					kind,
					tasks,
					maxConcurrency: params.maxConcurrency ?? DEFAULT_CONCURRENCY,
					signal: controller.signal,
					deps: { dashboard },
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
				disposeDashboard?.();
				disposeDashboard = undefined;
				ctx.ui.setStatus("parallel-agents", undefined);
				if (activeController === controller) activeController = undefined;
			}
		},
	});

	pi.on("session_shutdown", () => {
		activeController?.abort();
		activeController = undefined;
		disposeDashboard?.();
		disposeDashboard = undefined;
	});
}

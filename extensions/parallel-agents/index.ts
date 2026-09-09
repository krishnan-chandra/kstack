import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentPaneRun, getAgentPaneHost } from "../shared/agent-pane.ts";
import { runParallelAgents } from "./orchestrator.ts";
import type { ParallelAgentsDetails, ParallelAgentTask } from "./types.ts";

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
	cwd: Type.Optional(Type.String({ minLength: 1 })),
});

interface ParallelAgentsExtensionDeps {
	runAgents?: typeof runParallelAgents;
}

export default function parallelAgentsExtension(pi: ExtensionAPI, deps: ParallelAgentsExtensionDeps = {}): void {
	const runAgents = deps.runAgents ?? runParallelAgents;
	let activeController: AbortController | undefined;
	const paneHost = getAgentPaneHost(pi);

	pi.registerTool({
		name: "parallel_agents",
		label: "Parallel agents",
		description:
			"Run isolated read-only Pi subagents for the simplify skill with a live TUI dashboard. Children receive only read, grep, find, and ls; extensions, skills, prompt templates, and context files are disabled. Prompts are sent over stdin. Returns each final report in input order. Max 8 tasks and 4 concurrent by default.",
		promptSnippet: "Run visible isolated read-only subagents for the simplify workflow",
		promptGuidelines: [
			"Use parallel_agents instead of Herdr or manually spawned Pi processes when the simplify skill calls for parallel reviewers.",
		],
		parameters: Type.Object({
			tasks: Type.Array(TaskSchema, { minItems: 1, maxItems: MAX_TASKS }),
			maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TASKS })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (activeController) throw new Error("Another parallel_agents run is already active.");
			const labels = new Set<string>();
			const tasks: ParallelAgentTask[] = params.tasks.map((task) => ({
				label: task.label,
				model: task.model,
				prompt: task.prompt,
				cwd: task.cwd ?? ctx.cwd,
			}));
			for (const task of tasks) {
				if (labels.has(task.label)) throw new Error(`Duplicate task label: ${task.label}`);
				labels.add(task.label);
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
					title: "Simplify",
					clearPreviewOnComplete: true,
					onAbort: abort,
				});
				for (const task of tasks) pane.addChild({ id: task.label, label: task.label, model: task.model });
			} else {
				ctx.ui.setStatus("parallel-agents", `simplify: running ${tasks.length} agent(s)`);
			}
			try {
				const results = await runAgents({
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
				const details: ParallelAgentsDetails = { results };
				return {
					content: [
						{
							type: "text" as const,
							text: `simplify: ${completed}/${results.length} completed, ${failed} failed, ${aborted} aborted\n\n${reports.join("\n\n---\n\n")}`,
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

	pi.on("session_shutdown", () => {
		activeController?.abort();
		activeController = undefined;
	});
}

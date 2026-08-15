/** Isolated planner/implementer Pi subprocess lifecycle. */

import {
	type ChildEvent,
	type ChildRunnerDeps,
	childIsolationArgs,
	runChildAgent,
	type SpawnedProcess,
	type SpawnImpl,
	truncateHeadUtf8,
} from "../shared/child-agent-runner.ts";
import { type AgentRole, type AgentRunResult, type DeliveryMode, LIMITS, type WorkLocation } from "./types.ts";

export type { SpawnedProcess, SpawnImpl };
export interface RunnerDeps extends Omit<ChildRunnerDeps, "idleTimeoutMs" | "maxRuntimeMs"> {
	timeoutMs?: number;
}

interface BuildChildArgsOptions {
	role: AgentRole;
	model: string;
	promptFile: string;
	taskFile: string;
	planFile?: string;
	/** Mutable execution ledger copied from the approved plan for the implementer. */
	ledgerFile?: string;
	/** Panel-review verdict file, passed to the fixer and publisher roles. */
	verdictFile?: string;
	/** Delivery mode; defaults to "single" (current behavior). */
	mode?: DeliveryMode;
	/** Execution location for single-PR mutation phases. */
	workLocation?: WorkLocation;
	/** Stack mode only: skill paths re-added after --no-skills (Arena excluded). */
	skillPaths?: readonly string[];
	/** Ordered workflow guidance appended after the role prompt. */
	supplementalPrompts?: readonly string[];
}

/**
 * Skills and context files deliberately remain enabled in single-PR mode for
 * workflow composition. In stack mode, Arena is deterministically excluded by
 * disabling skill discovery (`--no-skills`) and re-adding every other skill
 * with repeated `--skill`; this prevents parallel candidates from corrupting a
 * shared jj operation log while preserving task-specific skills.
 */
export function buildChildArgs(options: BuildChildArgsOptions): string[] {
	const mode: DeliveryMode = options.mode ?? "single";
	const stackMode = mode === "stack";
	const worktreeNote =
		options.workLocation === "worktree"
			? " The parent created and selected this managed Git worktree. Work only in the current cwd, do not create or remove another worktree, and leave this worktree in place for explicit cleanup."
			: "";
	const skillFlags = stackMode ? expandRepeatedFlag("--skill", options.skillPaths) : [];

	let target: string;
	if (options.role === "planner") {
		const delivery = stackMode
			? 'This is a stacked-PR delivery. Begin the plan with a line reading exactly "Delivery: stacked-prs", then a line "Stack base: trunk()", then ordered PR slices.'
			: 'This is a single-PR delivery. Begin the plan with a line reading exactly "Delivery: single-pr".';
		target = `Read the user task at ${options.taskFile}, inspect the repository, and produce the plan. ${delivery}`;
	} else if (options.role === "implementer") {
		const stackNote = stackMode ? " This is a stacked-PR delivery; follow the appended local jj stack policy." : "";
		const ledgerNote = options.ledgerFile
			? ` Read and update the execution ledger at ${options.ledgerFile}; its final contents and the complete ledger in your response must close every plan item.`
			: " Include the complete execution ledger in your response, even if no ledger file was supplied.";
		target = `Read the user task at ${options.taskFile} and the approved plan at ${options.planFile}, then implement and verify it.${ledgerNote}${stackNote}${worktreeNote}`;
	} else if (options.role === "fixer") {
		const stackNote = stackMode
			? " This is a stacked-PR delivery; follow the appended local jj stack policy and amend the local stack instead of creating new commits."
			: "";
		target = `Read the user task at ${options.taskFile} and the panel-review verdict at ${options.verdictFile}, then address the actionable findings and verify your fixes.${stackNote}${worktreeNote}`;
	} else {
		const stackNote = stackMode
			? " This is a stacked-PR delivery; the parent already published the stack structure. Edit only titles and bodies for PR numbers in the trusted map and recommend reviewers. Do not push, create PRs, repair bases, or update navigation comments."
			: "";
		target = `Read the user task at ${options.taskFile} and the panel-review verdict at ${options.verdictFile}, then publish the change as a draft pull request and recommend reviewers. Consult the write-pr and find-reviewers skills.${stackNote}${worktreeNote}`;
	}

	return [
		...childIsolationArgs({ noSkills: stackMode }),
		...skillFlags,
		...(options.role === "planner" ? ["--tools", "read,grep,find,ls"] : []),
		"--model",
		options.model,
		"--append-system-prompt",
		options.promptFile,
		...expandRepeatedFlag("--append-system-prompt", options.supplementalPrompts),
		target,
	];
}

function expandRepeatedFlag(flag: string, values: readonly string[] | undefined): string[] {
	const args: string[] = [];
	for (const value of values ?? []) {
		if (value) args.push(flag, value);
	}
	return args;
}

export function truncateUtf8(text: string, maxBytes: number, label = "Output"): string {
	return truncateHeadUtf8(text, maxBytes, label);
}

export interface RunAgentOptions extends BuildChildArgsOptions {
	cwd: string;
	signal?: AbortSignal;
	deps?: RunnerDeps;
	onProgress?: (progress: { role: AgentRole; turns: number; activity: string; preview?: string }) => void;
	onEvent?: (event: ChildEvent) => void;
}

export async function runAgent(options: RunAgentOptions): Promise<AgentRunResult> {
	const deps = options.deps ?? {};
	const timeoutMs = deps.timeoutMs ?? LIMITS.defaultTimeoutMinutes * 60_000;
	const result = await runChildAgent({
		args: buildChildArgs(options),
		cwd: options.cwd,
		signal: options.signal,
		deps: {
			...deps,
			idleTimeoutMs: undefined,
			maxRuntimeMs: timeoutMs,
			outputCapBytes:
				deps.outputCapBytes ?? (options.role === "planner" ? LIMITS.plannerOutputBytes : LIMITS.implementerOutputBytes),
			stderrCapBytes: deps.stderrCapBytes ?? LIMITS.stderrBytes,
			stdoutLineCapBytes: deps.stdoutLineCapBytes ?? LIMITS.stdoutLineBytes,
			killGraceMs: deps.killGraceMs ?? LIMITS.killGraceMs,
		},
		onProgress: (progress) =>
			options.onProgress?.({
				role: options.role,
				turns: progress.turns,
				activity: progress.activity ?? "thinking",
				...(progress.preview !== undefined ? { preview: progress.preview } : {}),
			}),
		onEvent: options.onEvent,
	});
	const identity = { role: options.role, model: options.model };
	if (result.status === "completed")
		return { ...identity, status: "completed", output: result.output, usage: result.usage };
	if (result.status === "aborted") return { ...identity, status: "aborted" };
	let error = result.error;
	if (error.startsWith("Timed out: exceeded max runtime")) error = `Timed out after ${Math.round(timeoutMs / 1000)}s.`;
	if (error.startsWith("Child produced no output.")) error = `${options.role} produced no final output.`;
	return { ...identity, status: "failed", error };
}

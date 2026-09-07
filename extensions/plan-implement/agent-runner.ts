/** Hosted plan-implement role lifecycle over the shared Herdr AgentHost seam. */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentHost, AskResult, HostedAgent, HostedAgentSpec } from "../shared/herdr/agent-host.ts";
import { type AgentRole, type AgentRunResult, type DeliveryMode, LIMITS, type WorkLocation } from "./types.ts";

interface BuildRoleOptions {
	role: AgentRole;
	model: string;
	promptFile: string;
	taskFile: string;
	planFile?: string;
	ledgerFile?: string;
	verdictFile?: string;
	mode?: DeliveryMode;
	workLocation?: WorkLocation;
	skillPaths?: readonly string[];
	supplementalPrompts?: readonly string[];
}

export interface RunAgentOptions extends BuildRoleOptions {
	cwd: string;
	timeoutMs: number;
	outputCapBytes?: number;
	signal?: AbortSignal;
	instructions?: string;
}

interface RoleRunnerEffects {
	onStarted?: (role: AgentRole, model: string, paneId: string) => void;
	onBlocked?: (role: AgentRole, paneId: string) => Promise<boolean>;
}

export interface RoleRunner {
	readonly tabId: string;
	paneId(role: AgentRole): string | undefined;
	run(options: RunAgentOptions): Promise<AgentRunResult>;
	abortActive(): Promise<boolean>;
	dispose(): Promise<void>;
}

interface StartedRole {
	agent: HostedAgent;
	model: string;
	cwd: string;
}

function outputCap(role: AgentRole): number {
	if (role === "planner") return LIMITS.plannerOutputBytes;
	if (role === "adversary") return LIMITS.critiqueOutputBytes;
	return LIMITS.implementerOutputBytes;
}

/** Build the hosted Pi process contract for one role. */
export function buildRoleSpec(options: RunAgentOptions, systemPromptFile: string): HostedAgentSpec {
	const stackMode = options.mode === "stack";
	const spec: HostedAgentSpec = {
		role: options.role,
		model: options.model,
		cwd: options.cwd,
		systemPromptFiles: [systemPromptFile],
		sessionName: `plan-implement/${options.role}`,
	};
	if (options.role === "planner" || options.role === "adversary") spec.tools = ["read", "grep", "find", "ls"];
	if (stackMode) {
		spec.noSkills = true;
		if (options.skillPaths && options.skillPaths.length > 0) spec.skillPaths = options.skillPaths;
	}
	return spec;
}

/** Build the file-based instructions for a role ask. */
export function buildRoleInstructions(options: BuildRoleOptions): string {
	const stackMode = options.mode === "stack";
	const worktreeNote =
		options.workLocation === "worktree"
			? " The parent created and selected this managed Git worktree. Work only in the current cwd, do not create or remove another worktree, and leave this worktree in place for explicit cleanup."
			: "";
	if (options.role === "planner") {
		const delivery = stackMode
			? 'This is a stacked-PR delivery. Begin the plan with a line reading exactly "Delivery: stacked-prs", then a "Stack base:" line using the exact backend trunk named in the task file, then ordered PR slices.'
			: 'This is a single-PR delivery. Begin the plan with a line reading exactly "Delivery: single-pr".';
		return `Read the user task at ${options.taskFile}, inspect the repository, and produce the plan. ${delivery}`;
	}
	if (options.role === "adversary") {
		return `Read the user task at ${options.taskFile} and critique the complete implementation plan at ${options.planFile}. Return only the structured critique required by your system prompt.`;
	}
	if (options.role === "implementer") {
		const stackNote = stackMode
			? " This is a stacked-PR delivery; follow the appended backend-specific local stack policy."
			: "";
		const ledgerNote = options.ledgerFile
			? ` Read and update the execution ledger at ${options.ledgerFile}; its final contents and the complete ledger in your response must close every plan item.`
			: " Include the complete execution ledger in your response, even if no ledger file was supplied.";
		return `Read the user task at ${options.taskFile} and the approved plan at ${options.planFile}, then implement and verify it.${ledgerNote}${stackNote}${worktreeNote}`;
	}
	if (options.role === "fixer") {
		const stackNote = stackMode
			? " This is a stacked-PR delivery; follow the appended backend-specific local stack policy and amend the correct slice."
			: "";
		return `Read the user task at ${options.taskFile} and the panel-review verdict at ${options.verdictFile}, then address the actionable findings and verify your fixes.${stackNote}${worktreeNote}`;
	}
	const stackNote = stackMode
		? " This is a stacked-PR delivery; the parent already published the stack structure. Edit only titles and bodies for PR numbers in the trusted map and recommend reviewers. Do not push, create PRs, repair bases, or update navigation comments."
		: "";
	return `Read the user task at ${options.taskFile} and the panel-review verdict at ${options.verdictFile}, then publish the change as a draft pull request and recommend reviewers. Consult the write-pr and find-reviewers skills.${stackNote}${worktreeNote}`;
}

type AskUsage = AskResult["usage"];

function addUsage(total: AskUsage, next: AskUsage): void {
	total.input += next.input;
	total.output += next.output;
	total.cacheRead += next.cacheRead;
	total.cacheWrite += next.cacheWrite;
	total.cost += next.cost;
	total.turns += next.turns;
}

function withUsage(result: AskResult, usage: AskUsage): AskResult {
	if (result.status === "completed") {
		const completed: AskResult = { status: "completed", output: result.output, usage };
		if (result.session) completed.session = result.session;
		return completed;
	}
	if (result.status === "blocked") return { status: "blocked", paneId: result.paneId, usage };
	if (result.status === "aborted") return { status: "aborted", usage };
	const failed: AskResult = { status: "failed", error: result.error, usage };
	if (result.stderr) failed.stderr = result.stderr;
	return failed;
}

function mapAskResult(role: AgentRole, model: string, agent: HostedAgent, result: AskResult): AgentRunResult {
	if (result.status === "completed") {
		const completed: AgentRunResult = {
			status: "completed",
			role,
			model,
			output: result.output,
			usage: result.usage,
		};
		if (result.session) completed.session = result.session;
		return completed;
	}
	if (result.status === "blocked") {
		const blocked: AgentRunResult = { status: "blocked", role, model, paneId: result.paneId };
		if (agent.sessionFile) blocked.session = agent.sessionFile;
		return blocked;
	}
	if (result.status === "aborted") {
		const aborted: AgentRunResult = { status: "aborted", role, model };
		if (agent.sessionFile) aborted.session = agent.sessionFile;
		return aborted;
	}
	const failed: AgentRunResult = { status: "failed", role, model, error: result.error };
	if (agent.sessionFile) failed.session = agent.sessionFile;
	return failed;
}

/** Create a reusable role runner. Each role starts once and receives later asks in the same Pi session. */
export function createRoleRunner(host: AgentHost, effects: RoleRunnerEffects = {}): RoleRunner {
	const roles = new Map<AgentRole, StartedRole>();
	let sequence = 0;
	let active: HostedAgent | undefined;
	let disposed = false;

	const startRole = async (options: RunAgentOptions): Promise<StartedRole | AgentRunResult> => {
		const existing = roles.get(options.role);
		if (existing) {
			if (existing.model !== options.model || existing.cwd !== options.cwd) {
				return {
					status: "failed",
					role: options.role,
					model: options.model,
					error: `${options.role} was already started with a different model or cwd.`,
				};
			}
			return existing;
		}
		const promptParts = [readFileSync(options.promptFile, "utf8"), ...(options.supplementalPrompts ?? [])];
		const systemPromptFile = join(host.exchangeDir, `${sequence}-${options.role}-system.md`);
		writeFileSync(systemPromptFile, `${promptParts.join("\n\n---\n\n")}\n`, { mode: 0o600 });
		const started = await host.start(buildRoleSpec(options, systemPromptFile));
		if (!started.ok) {
			return { status: "failed", role: options.role, model: options.model, error: started.error };
		}
		const role = { agent: started.agent, model: options.model, cwd: options.cwd };
		roles.set(options.role, role);
		effects.onStarted?.(options.role, options.model, started.agent.paneId);
		return role;
	};

	const run = async (options: RunAgentOptions): Promise<AgentRunResult> => {
		if (disposed)
			return { status: "failed", role: options.role, model: options.model, error: "Role runner is disposed." };
		sequence++;
		const started = await startRole(options);
		if ("status" in started) return started;
		const instructionFile = join(host.exchangeDir, `${sequence}-${options.role}-instructions.md`);
		const outputFile = join(host.exchangeDir, `${sequence}-${options.role}-output.md`);
		writeFileSync(instructionFile, `${options.instructions ?? buildRoleInstructions(options)}\n`, { mode: 0o600 });
		active = started.agent;
		try {
			const accumulated: AskUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
			let result = await started.agent.ask({
				promptFile: instructionFile,
				outputFile,
				timeoutMs: options.timeoutMs,
				outputCapBytes: options.outputCapBytes ?? outputCap(options.role),
				signal: options.signal,
			});
			addUsage(accumulated, result.usage);
			while (result.status === "blocked" && effects.onBlocked) {
				if (!(await effects.onBlocked(options.role, result.paneId))) {
					await started.agent.abort();
					return mapAskResult(options.role, options.model, started.agent, {
						status: "aborted",
						usage: accumulated,
					});
				}
				result = await started.agent.resume({
					outputFile,
					timeoutMs: options.timeoutMs,
					outputCapBytes: options.outputCapBytes ?? outputCap(options.role),
					signal: options.signal,
				});
				addUsage(accumulated, result.usage);
			}
			return mapAskResult(options.role, options.model, started.agent, withUsage(result, accumulated));
		} finally {
			if (active === started.agent) active = undefined;
		}
	};

	return {
		tabId: host.tabId,
		paneId: (role) => roles.get(role)?.agent.paneId,
		run,
		async abortActive() {
			if (!active) return false;
			await active.abort();
			return true;
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			await host.dispose();
		},
	};
}

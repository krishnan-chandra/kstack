/** Isolated `--fast --worktree` implementer and its guidance composition. */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ChangeKind, changeKindPlaybookFile } from "../shared/change-kind.ts";
import {
	type ChildRunnerDeps,
	type ChildSession,
	childIsolationArgs,
	runChildAgent,
} from "../shared/child-agent-runner.ts";
import { readPromptAsset } from "../shared/prompt-assets.ts";
import type { VcsBackend, WorkstreamCheckpoint } from "../shared/vcs/backend.ts";
import { vcsChildGuidance } from "../shared/vcs/guidance.ts";
import type { RoleSpec } from "./types.ts";
import { LIMITS } from "./types.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(EXTENSION_DIR, "prompts");
const PLAYBOOKS_DIR = join(EXTENSION_DIR, "..", "shared", "playbooks");

export type FastImplementOutcome =
	| { status: "completed"; branch: string; cwd: string; output: string; session?: ChildSession }
	| {
			status: "failed" | "aborted";
			error: string;
			branch?: string;
			cwd?: string;
			output?: string;
			session?: ChildSession;
	  };

interface FastImplementRequest {
	task: string;
	changeKind: ChangeKind;
}

interface FastRunEffects {
	backend: VcsBackend;
	runChild?: typeof runChildAgent;
	deps?: ChildRunnerDeps;
	signal?: AbortSignal;
	timeoutMinutes?: number;
}

function buildFastChildArgs(model: string, promptFile: string, taskFile: string): string[] {
	// Keeps skills and context files available to the implementer.
	return [
		...childIsolationArgs({ noSkills: false }),
		"--model",
		model,
		"--append-system-prompt",
		promptFile,
		`Read the user task at ${taskFile}, inspect the repository, implement it, run focused verification, and commit coherent changes. Do not push, publish, open a PR, or land.`,
	];
}

export function buildFastImplementerGuidance(changeKind: ChangeKind, backend: Pick<VcsBackend, "id">): string {
	const playbook = changeKindPlaybookFile(changeKind);
	return [
		readPromptAsset(PROMPTS_DIR, "implementer-fast.md"),
		readPromptAsset(PLAYBOOKS_DIR, "engineering-principles.md"),
		...(playbook ? [readPromptAsset(PLAYBOOKS_DIR, playbook)] : []),
		vcsChildGuidance(backend.id),
	].join("\n\n---\n\n");
}

export async function runFastWorktree(
	request: FastImplementRequest,
	implementer: RoleSpec,
	initialCwd: string,
	fx: FastRunEffects,
): Promise<FastImplementOutcome> {
	if (!fx.backend.isolation) {
		return { status: "failed", error: "The configured VCS backend does not support managed worktrees." };
	}
	const preflight = await fx.backend.preflight(initialCwd);
	if (!preflight.ok) return { status: "failed", error: preflight.error };
	const planned = await fx.backend.isolation.plan(initialCwd, request.task);
	if (!planned.ok) return { status: "failed", error: planned.error };
	const created = await fx.backend.isolation.create(planned.plan);
	if (!created.ok) return { status: "failed", error: created.error };
	const cwd = created.plan.path;
	const branch = created.plan.ref;
	const checkpoint: WorkstreamCheckpoint = { ref: created.plan.ref, baseSha: created.plan.baseSha };
	// Everything after workstream creation stays inside one outcome boundary so
	// a throwing exec or filesystem failure still reports the retained branch.
	let temp: string | undefined;
	let childSession: FastImplementOutcome["session"];
	try {
		temp = mkdtempSync(join(tmpdir(), "kstack-fast-implement-"));
		const taskFile = join(temp, "task.md");
		const promptFile = join(temp, "prompt.md");
		writeFileSync(
			taskFile,
			`# User task\n\n${request.task}\n\nVCS backend: ${fx.backend.id}\nWorkstream: ${checkpoint.ref}\n`,
			{ mode: 0o600 },
		);
		writeFileSync(promptFile, buildFastImplementerGuidance(request.changeKind, fx.backend), { mode: 0o600 });
		chmodSync(taskFile, 0o600);
		chmodSync(promptFile, 0o600);
		const child = await (fx.runChild ?? runChildAgent)({
			args: buildFastChildArgs(
				`${implementer.model}${implementer.thinking ? `:${implementer.thinking}` : ""}`,
				promptFile,
				taskFile,
			),
			cwd,
			session: { owner: "plan-implement", label: "fast-implementer" },
			signal: fx.signal,
			deps: {
				...fx.deps,
				maxRuntimeMs: (fx.timeoutMinutes ?? LIMITS.defaultTimeoutMinutes) * 60_000,
				outputCapBytes: LIMITS.implementerOutputBytes,
				stderrCapBytes: LIMITS.stderrBytes,
				stdoutLineCapBytes: LIMITS.stdoutLineBytes,
				killGraceMs: LIMITS.killGraceMs,
			},
		});
		childSession = child.session;
		if (child.status !== "completed")
			return {
				status: child.status === "aborted" ? "aborted" : "failed",
				error: child.status === "aborted" ? "Implementation child was aborted." : child.error,
				branch,
				cwd,
				session: child.session,
			};
		const verified = await fx.backend.verifyRecordedWorkstream(cwd, {
			...checkpoint,
			requireNewCommit: true,
		});
		return verified.ok
			? { status: "completed", branch, cwd, output: child.output, session: child.session }
			: { status: "failed", error: verified.error, branch, cwd, output: child.output, session: child.session };
	} catch (error) {
		return {
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
			branch,
			cwd,
			...(childSession ? { session: childSession } : {}),
		};
	} finally {
		if (temp) rmSync(temp, { recursive: true, force: true });
	}
}

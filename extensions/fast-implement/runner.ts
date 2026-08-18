import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChangeKind, changeKindPlaybookFile } from "../shared/change-kind.ts";
import { type ChildRunnerDeps, childIsolationArgs, runChildAgent } from "../shared/child-agent-runner.ts";
import type { VcsBackend, WorkstreamCheckpoint } from "../shared/vcs/backend.ts";
import { type FastImplementOutcome, type FastImplementRequest, LIMITS, type ResolvedRole } from "./types.ts";

const extensionDir = new URL(".", import.meta.url);
const sharedPlaybooks = new URL("../shared/playbooks/", extensionDir);
export function buildChildArgs(model: string, promptFile: string, taskFile: string): string[] {
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
interface FastRunEffects {
	backend: VcsBackend;
	runChild?: typeof runChildAgent;
	deps?: ChildRunnerDeps;
	signal?: AbortSignal;
}

export function buildImplementerGuidance(changeKind: ChangeKind, backend: Pick<VcsBackend, "childGuidance">): string {
	const playbook = changeKindPlaybookFile(changeKind);
	return [
		readFileSync(new URL("implementer.md", new URL("prompts/", extensionDir)), "utf8"),
		readFileSync(new URL("engineering-principles.md", sharedPlaybooks), "utf8"),
		...(playbook ? [readFileSync(new URL(playbook, sharedPlaybooks), "utf8")] : []),
		backend.childGuidance(),
	].join("\n\n---\n\n");
}

export async function runWorktreeFastImplement(
	request: FastImplementRequest,
	role: ResolvedRole,
	initialCwd: string,
	fx: FastRunEffects,
): Promise<FastImplementOutcome> {
	if (request.workLocation !== "worktree" || !fx.backend.isolation) {
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
		writeFileSync(promptFile, buildImplementerGuidance(request.changeKind, fx.backend), { mode: 0o600 });
		chmodSync(taskFile, 0o600);
		chmodSync(promptFile, 0o600);
		const child = await (fx.runChild ?? runChildAgent)({
			args: buildChildArgs(
				`${role.implementer.model}${role.implementer.thinking ? `:${role.implementer.thinking}` : ""}`,
				promptFile,
				taskFile,
			),
			cwd,
			session: { owner: "fast-implement", label: "implementer" },
			signal: fx.signal,
			deps: {
				...fx.deps,
				maxRuntimeMs: role.timeoutMinutes * 60_000,
				outputCapBytes: LIMITS.outputBytes,
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

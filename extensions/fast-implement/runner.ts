import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ChangeKind, changeKindPlaybookFile } from "../shared/change-kind.ts";
import { type ChildRunnerDeps, childIsolationArgs, runChildAgent } from "../shared/child-agent-runner.ts";
import type { ExecFn } from "../shared/git-exec.ts";
import { createCurrentWorkstreamBranch, verifyCommittedWorkstream } from "../shared/git-policy.ts";
import { createManagedWorktree, planManagedWorktree } from "../shared/worktree.ts";
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
export interface FastRunEffects {
	exec: ExecFn;
	runChild?: typeof runChildAgent;
	deps?: ChildRunnerDeps;
	signal?: AbortSignal;
}
export async function runFastImplement(
	request: FastImplementRequest,
	role: ResolvedRole,
	initialCwd: string,
	fx: FastRunEffects,
): Promise<FastImplementOutcome> {
	let cwd = initialCwd;
	let branch: string | undefined;
	if (request.workLocation === "worktree") {
		const planned = await planManagedWorktree(initialCwd, request.task, fx.exec);
		if (!planned.ok) return { status: "failed", error: planned.error };
		const created = await createManagedWorktree(planned.plan, fx.exec);
		if (!created.ok) return { status: "failed", error: created.error };
		cwd = created.plan.path;
		branch = created.plan.branch;
	} else {
		const created = await createCurrentWorkstreamBranch(initialCwd, request.task, fx.exec);
		if (!created.ok) return { status: "failed", error: created.error };
		branch = created.branch;
	}
	// Everything after workstream creation stays inside one outcome boundary so
	// a throwing exec or filesystem failure still reports the retained branch.
	let temp: string | undefined;
	try {
		const base = await fx.exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 10_000 });
		if (base.code !== 0)
			return { status: "failed", error: "Could not resolve the prepared workstream base.", branch, cwd };
		temp = mkdtempSync(join(tmpdir(), "kstack-fast-implement-"));
		const taskFile = join(temp, "task.md");
		const promptFile = join(temp, "prompt.md");
		writeFileSync(taskFile, request.task, { mode: 0o600 });
		const playbook = changeKindPlaybookFile(request.changeKind);
		const guidance = [
			readFileSync(new URL("implementer.md", new URL("prompts/", extensionDir)), "utf8"),
			readFileSync(new URL("engineering-principles.md", sharedPlaybooks), "utf8"),
			...(playbook ? [readFileSync(new URL(playbook, sharedPlaybooks), "utf8")] : []),
		].join("\n\n---\n\n");
		writeFileSync(promptFile, guidance, { mode: 0o600 });
		chmodSync(taskFile, 0o600);
		chmodSync(promptFile, 0o600);
		const child = await (fx.runChild ?? runChildAgent)({
			args: buildChildArgs(
				`${role.implementer.model}${role.implementer.thinking ? `:${role.implementer.thinking}` : ""}`,
				promptFile,
				taskFile,
			),
			cwd,
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
		if (child.status !== "completed")
			return {
				status: child.status === "aborted" ? "aborted" : "failed",
				error: child.status === "aborted" ? "Implementation child was aborted." : child.error,
				branch,
				cwd,
			};
		const verified = await verifyCommittedWorkstream(cwd, fx.exec, {
			branch,
			baseSha: base.stdout.trim(),
			requireNewCommit: true,
		});
		return verified.ok
			? { status: "completed", branch, cwd, output: child.output }
			: { status: "failed", error: verified.error, branch, cwd, output: child.output };
	} catch (error) {
		return { status: "failed", error: error instanceof Error ? error.message : String(error), branch, cwd };
	} finally {
		if (temp) rmSync(temp, { recursive: true, force: true });
	}
}

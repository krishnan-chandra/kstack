/** Hosted `--fast` implementer for current and managed-worktree workstreams. */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ChangeKind, changeKindPlaybookFile } from "../shared/change-kind.ts";
import { readPromptAsset } from "../shared/prompt-assets.ts";
import type { VcsBackend, WorkstreamCheckpoint } from "../shared/vcs/backend.ts";
import { vcsPolicy } from "../shared/vcs/policy.ts";
import type { RoleRunner } from "./agent-runner.ts";
import { modelCliId } from "./config.ts";
import { LIMITS, type RoleSpec } from "./types.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(EXTENSION_DIR, "prompts");
const PLAYBOOKS_DIR = join(EXTENSION_DIR, "..", "shared", "playbooks");

export type FastImplementOutcome =
	| { status: "completed"; branch: string; cwd: string; output: string; session?: string }
	| {
			status: "failed" | "aborted";
			error: string;
			branch?: string;
			cwd?: string;
			output?: string;
			session?: string;
	  };

interface FastImplementRequest {
	task: string;
	changeKind: ChangeKind;
}

type OpenRoleRunner = { ok: true; runner: RoleRunner } | { ok: false; error: string };

interface FastRunEffects {
	backend: VcsBackend;
	openRunner(cwd: string): Promise<OpenRoleRunner>;
	signal?: AbortSignal;
	timeoutMinutes?: number;
}

export function buildFastImplementerGuidance(changeKind: ChangeKind, backend: Pick<VcsBackend, "id">): string {
	const playbook = changeKindPlaybookFile(changeKind);
	return [
		readPromptAsset(PROMPTS_DIR, "implementer-fast.md"),
		readPromptAsset(PLAYBOOKS_DIR, "engineering-principles.md"),
		...(playbook ? [readPromptAsset(PLAYBOOKS_DIR, playbook)] : []),
		vcsPolicy(backend.id).childGuidance,
	].join("\n\n---\n\n");
}

async function runHostedFast(
	request: FastImplementRequest,
	implementer: RoleSpec,
	cwd: string,
	checkpoint: WorkstreamCheckpoint,
	fx: FastRunEffects,
): Promise<FastImplementOutcome> {
	const branch = checkpoint.ref;
	let temp: string | undefined;
	let session: string | undefined;
	let runner: RoleRunner | undefined;
	try {
		const opened = await fx.openRunner(cwd);
		if (!opened.ok) return { status: "failed", error: opened.error, branch, cwd };
		runner = opened.runner;
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
		const result = await runner.run({
			role: "implementer",
			model: modelCliId(implementer),
			promptFile,
			taskFile,
			cwd,
			timeoutMs: (fx.timeoutMinutes ?? LIMITS.defaultTimeoutMinutes) * 60_000,
			outputCapBytes: LIMITS.implementerOutputBytes,
			signal: fx.signal,
			instructions: `Read the user task at ${taskFile}, inspect the repository, implement it, run focused verification, and commit coherent changes. Do not push, publish, open a PR, or land.`,
		});
		session = result.session;
		if (result.status !== "completed") {
			let error = "Implementation hosted agent was aborted.";
			if (result.status === "failed") error = result.error;
			else if (result.status === "blocked") error = `Implementation hosted agent is blocked in pane ${result.paneId}.`;
			const failed: FastImplementOutcome = {
				status: result.status === "aborted" ? "aborted" : "failed",
				error,
				branch,
				cwd,
			};
			if (session) failed.session = session;
			return failed;
		}
		const verified = await fx.backend.verifyRecordedWorkstream(cwd, {
			...checkpoint,
			requireNewCommit: true,
		});
		if (!verified.ok) {
			const failed: FastImplementOutcome = {
				status: "failed",
				error: verified.error,
				branch,
				cwd,
				output: result.output,
			};
			if (session) failed.session = session;
			return failed;
		}
		const completed: FastImplementOutcome = { status: "completed", branch, cwd, output: result.output };
		if (session) completed.session = session;
		return completed;
	} catch (error) {
		const failed: FastImplementOutcome = {
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
			branch,
			cwd,
		};
		if (session) failed.session = session;
		return failed;
	} finally {
		await runner?.dispose();
		if (temp) rmSync(temp, { recursive: true, force: true });
	}
}

export async function runFastCurrent(
	request: FastImplementRequest,
	implementer: RoleSpec,
	cwd: string,
	fx: FastRunEffects,
): Promise<FastImplementOutcome> {
	const preflight = await fx.backend.preflight(cwd);
	if (!preflight.ok) return { status: "failed", error: preflight.error };
	const created = await fx.backend.createWorkstream(cwd, request.task);
	if (!created.ok) return { status: "failed", error: created.error };
	return runHostedFast(request, implementer, cwd, created, fx);
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
	const checkpoint: WorkstreamCheckpoint = { ref: created.plan.ref, baseSha: created.plan.baseSha };
	return runHostedFast(request, implementer, created.plan.path, checkpoint, fx);
}

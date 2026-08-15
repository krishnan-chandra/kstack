/**
 * Bounded PR autopilot state machine.
 *
 * One PR at a time, lowest unmerged first. Tiny models only. The loop:
 *
 *   refresh snapshot → conflicts/behind (merge base, never rebase)
 *   → unresolved threads (fix / dismiss / ask)
 *   → watch pending CI instead of inventing work
 *   → flake retrigger once
 *   → code CI (after comments, on the current SHA)
 *   → verify, push, recheck
 *
 * Modes:
 *   check    — one status pass, report, stop.
 *   threads  — address review threads only, then push.
 *   drive    — loop until merge-ready or a hard blocker (3 fix cycles).
 *   watch    — same as drive with more cycles, watching CI between ticks.
 *   cleanup  — remove the managed worktree and branch after confirmation.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VcsBackend } from "../shared/vcs/backend.ts";
import { runAgent } from "./agent-runner.ts";
import {
	attachFailedLogs,
	getCheckRuns,
	getIssueComments,
	getReviewThreads,
	isForbiddenStagingPath,
	replyToIssueComment,
	replyToReviewComment,
	resolveReviewThread,
	viewPR,
} from "./github.ts";
/** Lifecycle phases surfaced to the parent UI for status display. */
import { buildPRState } from "./pr-state.ts";
import {
	type AutopilotMode,
	type AutopilotPersistedState,
	type ExecFn,
	type FailureClass,
	LIMITS,
	type PRState,
	type ReviewThread,
	type ThreadDecision,
	type UsageSummary,
} from "./types.ts";
import { shouldForceAsk } from "./untrusted.ts";

interface PushResult {
	ok: boolean;
	headSha?: string;
	error?: string;
}
export function repoPersistKey(cwd: string): string {
	return createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 12);
}

export function persistPath(repoKey: string, prNumber: number): string {
	return join(tmpdir(), `pi-pr-autopilot-state-${repoKey}-${prNumber}.json`);
}

function emptyPersistedState(repoKey: string, prNumber: number): AutopilotPersistedState {
	return { repoKey, prNumber, headSha: "", handledThreadIds: [], repliedThreadIds: [], flakeRetried: [] };
}

export async function loadPersistedState(repoKey: string, prNumber: number): Promise<AutopilotPersistedState> {
	try {
		const raw: unknown = JSON.parse(await readFile(persistPath(repoKey, prNumber), "utf8"));
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
			return emptyPersistedState(repoKey, prNumber);
		}
		const obj = raw as Record<string, unknown>;
		const handled = Array.isArray(obj.handledThreadIds)
			? obj.handledThreadIds.filter((id): id is string => typeof id === "string")
			: [];
		const replied = Array.isArray(obj.repliedThreadIds)
			? obj.repliedThreadIds.filter((id): id is string => typeof id === "string")
			: [];
		const flake = Array.isArray(obj.flakeRetried)
			? obj.flakeRetried.filter((id): id is string => typeof id === "string")
			: [];
		return {
			repoKey,
			prNumber,
			headSha: typeof obj.headSha === "string" ? obj.headSha : "",
			handledThreadIds: handled,
			repliedThreadIds: replied,
			flakeRetried: flake,
		};
	} catch {
		return emptyPersistedState(repoKey, prNumber);
	}
}

export async function savePersistedState(state: AutopilotPersistedState): Promise<void> {
	await writeFile(persistPath(state.repoKey, state.prNumber), JSON.stringify(state), { mode: 0o600 });
}

function filterHandledThreads(threads: ReviewThread[], handled: string[]): ReviewThread[] {
	const set = new Set(handled);
	return threads.filter((t) => !set.has(t.id));
}

export async function fetchPRState(
	exec: ExecFn,
	cwd: string,
	prNumber: number,
	existingVerifiedSha: string | null,
	opts: { concurrency: number; handledThreadIds: string[] },
): Promise<PRState | string> {
	const prResult = await viewPR(exec, cwd, prNumber);
	if (!prResult.pr) return prResult.stderr || `Could not view PR #${prNumber}.`;

	const [threadsResult, issueResult, checksResult] = await Promise.all([
		getReviewThreads(exec, cwd, prNumber),
		getIssueComments(exec, cwd, prNumber),
		getCheckRuns(exec, cwd, prNumber),
	]);

	const failures = [
		["review threads", threadsResult],
		["issue comments", issueResult],
		["checks", checksResult],
	] as const;
	for (const [label, result] of failures) {
		if (result.code !== 0)
			return `Could not fetch ${label} for PR #${prNumber}: ${result.stderr.trim() || "unknown GitHub error"}`;
	}

	const checks = await attachFailedLogs(exec, cwd, checksResult.checks, opts.concurrency);
	const threads = filterHandledThreads([...threadsResult.threads, ...issueResult.threads], opts.handledThreadIds);
	return buildPRState(prResult.pr, threads, checks, existingVerifiedSha);
}

export async function runChildRole(
	role: "triager" | "fixer",
	opts: {
		model: string;
		thinking?: string;
		promptFile: string;
		taskFile: string;
		timeoutMinutes: number;
		maxRuntimeMinutes: number;
	},
	ctx: { cwd: string; signal?: AbortSignal },
): Promise<{ ok: true; output: string; usage: UsageSummary } | { ok: false; error: string; usage: UsageSummary }> {
	const result = await runAgent({
		role,
		spec: { label: role, model: opts.model, thinking: opts.thinking },
		promptFile: opts.promptFile,
		taskFile: opts.taskFile,
		cwd: ctx.cwd,
		tools: role === "triager" ? "read,grep,find,ls" : "read,grep,find,ls,bash,write,edit",
		signal: ctx.signal,
		deps: {
			timeoutMs: opts.timeoutMinutes * 60_000,
			maxRuntimeMs: opts.maxRuntimeMinutes * 60_000,
		},
	});
	if (result.status === "completed") {
		return { ok: true, output: result.output, usage: result.usage };
	}
	const label = role === "triager" ? "Triager" : "Fixer";
	return {
		ok: false,
		error: result.status === "aborted" ? `${label} was aborted.` : `${label} failed: ${result.error}`,
		usage: result.usage,
	};
}

export async function prepareMutationCheckout(
	backend: VcsBackend,
	cwd: string,
	state: PRState,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const [current, head, clean] = await Promise.all([
		backend.currentRef(cwd),
		backend.headSha(cwd),
		backend.isWorkingCopyEmpty(cwd),
	]);
	const refName =
		current.ok && (current.ref.kind === "branch" || current.ref.kind === "bookmark") ? current.ref.name : undefined;
	if (refName !== state.headRef) {
		return {
			ok: false,
			error: `Selected PR #${state.number} uses ${state.headRef}, but the checkout is on ${refName ?? "a detached HEAD"}. Open its managed worktree first.`,
		};
	}
	if (!head.ok || head.sha !== state.headSha) {
		return {
			ok: false,
			error: `Local HEAD ${head.ok ? head.sha : "could not be read"} does not match PR #${state.number} head ${state.headSha}. Synchronize the PR worktree first.`,
		};
	}
	if (!clean.ok) return clean;
	if (!clean.empty) return { ok: false, error: "The PR worktree must be clean before pr-autopilot can mutate it." };
	const integrated = await backend.integrateRemoteHead(cwd, state.headRef);
	if (!integrated.ok) return integrated;
	const synchronizedHead = await backend.headSha(cwd);
	if (!synchronizedHead.ok || synchronizedHead.sha !== state.headSha) {
		return {
			ok: false,
			error: `The remote PR head advanced to ${synchronizedHead.ok ? synchronizedHead.sha : "an unreadable SHA"}; refresh GitHub state before editing.`,
		};
	}
	return { ok: true };
}

export async function doCommitAndPush(
	backend: VcsBackend,
	cwd: string,
	headRef: string,
	expectedHeadSha: string,
	prNumber: number,
	fixerOutput: string,
): Promise<PushResult> {
	if (/\bVERIFY_FAIL\b/.test(fixerOutput)) {
		return { ok: false, error: "Fixer reported VERIFY_FAIL — not pushing a fix that failed its own checks." };
	}

	const [current, head, changed] = await Promise.all([
		backend.currentRef(cwd),
		backend.headSha(cwd),
		backend.changedPaths(cwd),
	]);
	const refName =
		current.ok && (current.ref.kind === "branch" || current.ref.kind === "bookmark") ? current.ref.name : undefined;
	if (refName !== headRef || !head.ok || head.sha !== expectedHeadSha) {
		return {
			ok: false,
			error: `The fixer changed checkout identity (expected ${headRef}@${expectedHeadSha}, found ${refName ?? "detached"}@${head.ok ? head.sha : "unknown"}). Refusing to publish.`,
		};
	}
	if (!changed.ok) return { ok: false, error: `Could not inspect fixer changes: ${changed.error}` };
	const paths = changed.paths;
	if (paths.length === 0) return { ok: true, error: "no changes to commit" };

	const forbidden = paths.filter(isForbiddenStagingPath);
	const allowed = paths.filter((p) => !isForbiddenStagingPath(p));
	if (forbidden.length > 0) {
		const restored = await backend.restorePaths(cwd, forbidden);
		return {
			ok: false,
			error: `Fixer touched forbidden paths: ${forbidden.join(", ")}.${restored.ok ? " Those changes were restored." : ` Automatic restoration failed: ${restored.error}`}`,
		};
	}
	if (allowed.length === 0) return { ok: true, error: "no changes to commit" };

	const committed = await backend.commitPaths(
		cwd,
		allowed,
		`Autopilot PR #${prNumber}: address review threads and CI failures\n\nCo-authored-by: pr-autopilot (tiny models)`,
	);
	if (!committed.ok) return committed;
	const pushed = await backend.push(cwd, headRef);
	if (!pushed.ok) return pushed;
	const committedHead = await backend.headSha(cwd);
	return { ok: true, headSha: committedHead.ok ? committedHead.sha : undefined };
}

export async function runCleanup(
	backend: VcsBackend,
	cwd: string,
	confirm: (label: string, body: string) => Promise<boolean>,
	notify: (msg: string, level: "info" | "warning" | "error") => void,
): Promise<boolean> {
	const current = await backend.currentRef(cwd);
	const branch = current.ok && current.ref.kind === "branch" ? current.ref.name : "";

	if (!branch.startsWith("kstack/")) {
		notify(
			`Current branch ${branch || "(detached)"} is not a managed kstack worktree. Cleanup is a no-op for non-managed branches.`,
			"warning",
		);
		return true;
	}

	const confirmed = await confirm(
		"Remove managed worktree and branch?",
		`Branch: ${branch}\n` +
			`Path: ${cwd}\n\n` +
			"This will:\n" +
			`1. Remove the Git worktree at ${cwd}\n` +
			`2. Delete branch ${branch} (if safe)\n\n` +
			"Session archival is a separate manual step. This cleanup is irreversible. Continue?",
	);
	if (!confirmed) return false;

	const removed = await backend.removeIsolation(cwd, branch);
	if (!removed.ok) {
		notify(removed.error, "error");
		return false;
	}
	if (removed.warning) notify(removed.warning, "warning");

	notify("Managed worktree and branch removed. To archive the linked Pi session, run: /session-archive", "info");
	return true;
}

function parseFailureClass(raw: unknown): FailureClass {
	if (raw === "code" || raw === "stale-base" || raw === "flake" || raw === "infra" || raw === "unknown") return raw;
	return "unknown";
}

function parseDecision(raw: unknown): ThreadDecision | undefined {
	if (raw === "fix" || raw === "dismiss" || raw === "ask") return raw;
	return undefined;
}

interface ParsedCheck {
	name: string;
	cls: FailureClass;
	action: string;
}
type ParsedThread =
	| { id: string; decision: "fix"; cls: FailureClass; action: string; reply: string }
	| { id: string; decision: "dismiss"; action: string; reply: string }
	| { id: string; decision: "ask"; action: string };

interface ParsedTriage {
	checks: ParsedCheck[];
	threads: ParsedThread[];
	conflicts: boolean;
	draft: boolean;
	summary: string;
}

function parseThreadEntry(raw: unknown): ParsedThread | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const obj = raw as Record<string, unknown>;
	const id = typeof obj.id === "string" ? obj.id : undefined;
	if (!id) return undefined;
	const decision = parseDecision(obj.decision);
	if (!decision) return undefined;
	const action = typeof obj.action === "string" ? obj.action : "";
	const reply = typeof obj.reply === "string" ? obj.reply : action;
	switch (decision) {
		case "fix":
			return { id, decision, cls: parseFailureClass(obj.cls), action, reply };
		case "dismiss":
			return { id, decision, action, reply };
		case "ask":
			return { id, decision, action };
		default: {
			const _exhaustive: never = decision;
			return _exhaustive;
		}
	}
}

/** Parse a triage JSON blob or one explicit fenced JSON block. */
export function parseTriage(triage: string): ParsedTriage | { error: string } {
	const trimmed = triage.trim();
	const fences = [...trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n```/gi)];
	if (fences.length > 1) return { error: "Triage output contained multiple fenced blocks." };
	const cleaned = fences.length === 1 ? fences[0][1].trim() : trimmed;
	let parsed: unknown;
	try {
		parsed = JSON.parse(cleaned);
	} catch (err) {
		return { error: `Could not parse triage JSON: ${(err as Error).message}` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { error: "Triage JSON must be an object." };
	}
	const obj = parsed as Record<string, unknown>;
	const checksRaw = Array.isArray(obj.checks) ? obj.checks : [];
	const threadsRaw = Array.isArray(obj.threads) ? obj.threads : [];
	const checks: ParsedCheck[] = [];
	for (const item of checksRaw) {
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const row = item as Record<string, unknown>;
		if (typeof row.name !== "string") continue;
		checks.push({
			name: row.name,
			cls: parseFailureClass(row.cls),
			action: typeof row.action === "string" ? row.action : "",
		});
	}
	const threads = threadsRaw.flatMap((item) => {
		const parsedThread = parseThreadEntry(item);
		return parsedThread ? [parsedThread] : [];
	});
	return {
		checks,
		threads,
		conflicts: obj.conflicts === true,
		draft: obj.draft === true,
		summary: typeof obj.summary === "string" ? obj.summary : "",
	};
}

/** Apply parent-side force-ask for sensitive or injection-like comments. */
export function applyForceAsk(state: PRState, parsed: ParsedTriage): ParsedTriage {
	const byId = new Map(state.threads.map((t) => [t.id, t]));
	const threads = parsed.threads.map((thread) => {
		const source = byId.get(thread.id);
		if (!source || !shouldForceAsk(source.body)) return thread;
		if (thread.decision === "ask") return thread;
		return {
			id: thread.id,
			decision: "ask" as const,
			action: thread.action || "Forced ask: sensitive or untrusted comment.",
		};
	});
	for (const source of state.threads) {
		if (!shouldForceAsk(source.body)) continue;
		if (threads.some((t) => t.id === source.id)) continue;
		threads.push({ id: source.id, decision: "ask", action: "Forced ask: sensitive or untrusted comment." });
	}
	return { ...parsed, threads };
}

export function summarizeTriage(triage: string): string {
	const parsed = parseTriage(triage);
	if ("error" in parsed) return "triage JSON parse failed";
	return `${parsed.checks.length} checks, ${parsed.threads.length} threads analyzed. ${parsed.summary || ""}`;
}

export function classifyBlockers(parsed: ParsedTriage): { hasUnfixableCI: boolean; hasAskThreads: boolean } {
	const hasUnfixableCI = parsed.checks.some((c) => c.cls === "infra" || c.cls === "unknown" || c.cls === "stale-base");
	const hasAskThreads = parsed.threads.some((t) => t.decision === "ask");
	return { hasUnfixableCI, hasAskThreads };
}

export async function applyThreadReplies(
	exec: ExecFn,
	cwd: string,
	state: PRState,
	parsed: ParsedTriage,
	opts: { resolveFix: boolean; repliedThreadIds: string[] },
	notify: (msg: string, level: "info" | "warning" | "error") => void,
): Promise<string[]> {
	const handled: string[] = [];
	const byId = new Map(state.threads.map((t) => [t.id, t]));
	for (const thread of parsed.threads) {
		if (thread.decision === "ask") continue;
		if (thread.decision === "fix" && !opts.resolveFix) continue;
		const source = byId.get(thread.id);
		if (!source) continue;
		const reply = thread.decision === "fix" || thread.decision === "dismiss" ? thread.reply : "";
		const body =
			reply.trim() ||
			(thread.decision === "dismiss"
				? `Dismissing: ${thread.action}`
				: `Addressed in a follow-up commit. ${thread.action}`);
		if (source.source === "review-thread") {
			if (source.replyToId !== undefined && !opts.repliedThreadIds.includes(thread.id)) {
				const posted = await replyToReviewComment(exec, cwd, state.number, source.replyToId, body);
				if (posted.code !== 0) {
					notify(`Could not reply to thread ${thread.id}: ${posted.stderr.trim()}`, "warning");
					continue;
				}
				opts.repliedThreadIds.push(thread.id);
			}
			const resolved = await resolveReviewThread(exec, cwd, thread.id);
			if (resolved.code !== 0) {
				notify(`Could not resolve thread ${thread.id}: ${resolved.stderr.trim()}`, "warning");
				continue;
			}
			handled.push(thread.id);
		} else {
			const posted = await replyToIssueComment(exec, cwd, state.number, body);
			if (posted.code !== 0) {
				notify(`Could not reply to discussion ${thread.id}: ${posted.stderr.trim()}`, "warning");
				continue;
			}
			handled.push(thread.id);
		}
	}
	return handled;
}

export function maxFixCycles(mode: AutopilotMode): number {
	switch (mode) {
		case "threads":
			return 1;
		case "drive":
			return LIMITS.maxDriveCycles;
		case "watch":
			return LIMITS.maxWatchCycles;
		case "check":
		case "cleanup":
			return 0;
		default: {
			const _exhaustive: never = mode;
			return _exhaustive;
		}
	}
}

import { type BoundaryValue, isNumber, isObject, isString, type JsonObject } from "../shared/validation.ts";
/**
 * Bounded PR autopilot state machine.
 *
 * One PR at a time, lowest unmerged first. Configured models only. The loop:
 *
 *   refresh snapshot → conflicts/behind (merge base, never rebase)
 *   → unresolved review items (fix / dismiss / ask / ignore)
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

import { createHash, randomUUID } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { commandDiagnostic } from "../shared/git-exec.ts";
import { getAgentDir } from "../shared/kstack-config.ts";
import type { VcsBackend } from "../shared/vcs/backend.ts";
import { runAgent } from "./agent-runner.ts";
import {
	getCheckRuns,
	getIssueComments,
	getReviewThread,
	getReviewThreads,
	replyToIssueComment,
	replyToReviewComment,
	resolveReviewThread,
	viewPR,
} from "./github.ts";
/** Lifecycle phases surfaced to the parent UI for status display. */
import { buildPRState, emptyUsage } from "./pr-state.ts";
import {
	appendPendingReviewReply,
	filterHandledReviewItems,
	hasPendingReviewReply,
	removePendingReviewReplies,
} from "./review-handling.ts";
import {
	type CheckTriageKey,
	checkForTriageKey,
	isCheckTriageKey,
	isThreadTriageKey,
	type ThreadTriageKey,
	threadForTriageKey,
	threadTriageKey,
} from "./triage-keys.ts";
import {
	type AutopilotMode,
	type AutopilotPersistedState,
	type AutopilotThinkingLevel,
	type ExecFn,
	type FailureClass,
	type HandledReviewRecord,
	LIMITS,
	type LoadedAutopilotState,
	type PendingReviewReply,
	type PRState,
	type ThreadDecision,
	type UsageSummary,
} from "./types.ts";
import { shouldForceAsk } from "./untrusted.ts";

export function repoPersistKey(cwd: string): string {
	return createHash("sha256").update(realpathSync(cwd)).digest("hex").slice(0, 12);
}

export function persistPath(repoKey: string, prNumber: number): string {
	return join(getAgentDir(), "pr-autopilot", `state-${repoKey}-${prNumber}.json`);
}

function emptyPersistedState(repoKey: string, prNumber: number): AutopilotPersistedState {
	return {
		schemaVersion: 2,
		repoKey,
		prNumber,
		headSha: "",
		handled: [],
		pendingReviewReplies: [],
		legacyPendingReplyIds: [],
		flakeRetried: [],
	};
}

function blockedState(repoKey: string, prNumber: number, reason: string): LoadedAutopilotState {
	return {
		kind: "blocked",
		state: emptyPersistedState(repoKey, prNumber),
		reviewMutationBlocker: `PR autopilot state needs inspection: ${reason}`,
	};
}

function isStringArray(value: BoundaryValue): value is string[] {
	return Array.isArray(value) && value.every(isString);
}

function isReviewVersion(value: BoundaryValue): value is string {
	return isString(value) && /^[0-9a-f]{64}$/.test(value);
}

function parseHandledRecord(raw: BoundaryValue): HandledReviewRecord | undefined {
	if (!isObject(raw) || raw === null || Array.isArray(raw)) return undefined;
	const record =
		/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ raw as JsonObject;
	if (!isString(record.id) || record.id.length === 0 || !isReviewVersion(record.version)) return undefined;
	const decision = parseDecision(record.decision);
	if (!decision || decision === "ask") return undefined;
	if (record.source !== "review-thread" && record.source !== "issue-comment") return undefined;
	return { id: record.id, source: record.source, version: record.version, decision };
}

function parsePendingReply(raw: BoundaryValue): PendingReviewReply | undefined {
	if (!isObject(raw) || raw === null || Array.isArray(raw)) return undefined;
	const record =
		/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ raw as JsonObject;
	if (!isString(record.id) || record.id.length === 0 || !isReviewVersion(record.version)) return undefined;
	return { id: record.id, version: record.version };
}

function parseV2State(obj: JsonObject, repoKey: string, prNumber: number): LoadedAutopilotState {
	if (obj.repoKey !== repoKey || obj.prNumber !== prNumber || !isString(obj.headSha)) {
		return blockedState(repoKey, prNumber, "schema 2 identity or head fields are malformed.");
	}
	if (
		!Array.isArray(obj.handled) ||
		!Array.isArray(obj.pendingReviewReplies) ||
		!isStringArray(obj.legacyPendingReplyIds) ||
		!isStringArray(obj.flakeRetried)
	) {
		return blockedState(repoKey, prNumber, "schema 2 arrays are malformed.");
	}
	const handled = obj.handled.map(parseHandledRecord);
	const pending = obj.pendingReviewReplies.map(parsePendingReply);
	if (handled.some((record) => record === undefined) || pending.some((record) => record === undefined)) {
		return blockedState(repoKey, prNumber, "schema 2 review records are malformed.");
	}
	if (
		handled.length > LIMITS.reviewHandlingRecords ||
		pending.length > LIMITS.reviewHandlingRecords ||
		obj.legacyPendingReplyIds.length > LIMITS.reviewHandlingRecords
	) {
		return blockedState(repoKey, prNumber, "schema 2 review records exceed their bounds.");
	}
	return {
		kind: "ready",
		state: {
			schemaVersion: 2,
			repoKey,
			prNumber,
			headSha: obj.headSha,
			handled: handled.flatMap((record) => (record ? [record] : [])),
			pendingReviewReplies: pending.flatMap((record) => (record ? [record] : [])),
			legacyPendingReplyIds: [...new Set(obj.legacyPendingReplyIds)],
			flakeRetried: [...new Set(obj.flakeRetried)],
		},
	};
}

function parseLegacyState(obj: JsonObject, repoKey: string, prNumber: number): LoadedAutopilotState {
	if (obj.repoKey !== repoKey || obj.prNumber !== prNumber) {
		return blockedState(repoKey, prNumber, "legacy state identity does not match its repository and PR.");
	}
	if (
		!isString(obj.headSha) ||
		!isStringArray(obj.handledThreadIds) ||
		!isStringArray(obj.repliedThreadIds) ||
		!isStringArray(obj.flakeRetried)
	) {
		return blockedState(repoKey, prNumber, "legacy state is malformed.");
	}
	if (obj.repliedThreadIds.length > LIMITS.reviewHandlingRecords) {
		return blockedState(repoKey, prNumber, "legacy pending replies exceed their bound.");
	}
	return {
		kind: "ready",
		state: {
			...emptyPersistedState(repoKey, prNumber),
			headSha: obj.headSha,
			legacyPendingReplyIds: [...new Set(obj.repliedThreadIds)],
			flakeRetried: [...new Set(obj.flakeRetried)],
		},
		migrationNote:
			"Migrated legacy review state: prior handled IDs will be triaged once more; unversioned pending replies need inspection before resolution.",
	};
}

function parsePersistedState(raw: BoundaryValue, repoKey: string, prNumber: number): LoadedAutopilotState {
	if (!isObject(raw) || raw === null || Array.isArray(raw)) {
		return blockedState(repoKey, prNumber, "the state file is not an object.");
	}
	const obj =
		/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ raw as JsonObject;
	if (obj.schemaVersion === undefined) return parseLegacyState(obj, repoKey, prNumber);
	if (!isNumber(obj.schemaVersion) || !Number.isInteger(obj.schemaVersion)) {
		return blockedState(repoKey, prNumber, "schemaVersion is malformed.");
	}
	if (obj.schemaVersion !== 2) {
		return blockedState(repoKey, prNumber, `unsupported schemaVersion ${obj.schemaVersion}.`);
	}
	return parseV2State(obj, repoKey, prNumber);
}

type StateDirCheck = "missing" | "directory" | "unsafe";

/**
 * Inspect the state directory without following a symlink. A symlink here is
 * refused rather than traversed because `mkdir` would otherwise follow it and
 * `O_NOFOLLOW` on the state file only guards its final path component.
 */
async function checkStateDir(dir: string): Promise<StateDirCheck> {
	try {
		const stat = await lstat(dir);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return "unsafe";
		return "directory";
	} catch {
		return "missing";
	}
}

export async function loadPersistedState(repoKey: string, prNumber: number): Promise<LoadedAutopilotState> {
	const path = persistPath(repoKey, prNumber);
	const stateDir = await checkStateDir(dirname(path));
	if (stateDir === "missing") return { kind: "ready", state: emptyPersistedState(repoKey, prNumber) };
	if (stateDir === "unsafe") return blockedState(repoKey, prNumber, "the state directory is unsafe.");
	let handle: FileHandle;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		const code = /* SAFETY: Node filesystem errors expose an optional string code. */ (error as NodeJS.ErrnoException)
			.code;
		if (code === "ENOENT") return { kind: "ready", state: emptyPersistedState(repoKey, prNumber) };
		return blockedState(repoKey, prNumber, "the state file could not be opened safely.");
	}
	try {
		let raw: BoundaryValue;
		try {
			raw = JSON.parse(await handle.readFile("utf8"));
		} catch {
			return blockedState(repoKey, prNumber, "the state file is not valid JSON.");
		}
		return parsePersistedState(raw, repoKey, prNumber);
	} finally {
		await handle.close();
	}
}

export async function savePersistedState(state: AutopilotPersistedState): Promise<void> {
	const path = persistPath(state.repoKey, state.prNumber);
	const dir = dirname(path);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	if ((await checkStateDir(dir)) !== "directory") return;
	const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		const handle = await open(
			tempPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await handle.writeFile(JSON.stringify(state), "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tempPath, path);
	} catch (error) {
		await unlink(tempPath).catch(() => {});
		const code = /* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (
			error as NodeJS.ErrnoException
		).code;
		if (code === "ELOOP" || code === "ENOTDIR") return;
		throw error;
	}
}

export async function fetchPRState(
	exec: ExecFn,
	cwd: string,
	prNumber: number,
	existingVerifiedSha: string | null,
	reviewHandling: Pick<AutopilotPersistedState, "handled" | "pendingReviewReplies" | "legacyPendingReplyIds">,
	repo?: string,
	signal?: AbortSignal,
): Promise<PRState | string> {
	const prResult = await viewPR(exec, cwd, prNumber);
	if (!prResult.pr) return prResult.stderr || `Could not view PR #${prNumber}.`;

	const [threadsResult, issueResult, checksResult] = await Promise.all([
		getReviewThreads(exec, cwd, prNumber, repo, signal),
		getIssueComments(exec, cwd, prNumber, repo),
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

	const uncertainPending = new Set([
		...reviewHandling.pendingReviewReplies.map((record) => record.id),
		...reviewHandling.legacyPendingReplyIds,
	]);
	const suppressions = reviewHandling.handled.filter((record) => !uncertainPending.has(record.id));
	const threads = filterHandledReviewItems([...threadsResult.threads, ...issueResult.threads], suppressions);
	return buildPRState(prResult.pr, threads, checksResult.checks, existingVerifiedSha);
}

export async function runChildRole(
	role: "triager" | "fixer",
	opts: {
		model: string;
		thinking?: AutopilotThinkingLevel;
		promptFile: string;
		taskFile: string;
		timeoutMinutes: number;
		maxRuntimeMinutes: number;
	},
	ctx: { cwd: string; signal?: AbortSignal },
): Promise<{ ok: true; output: string; usage: UsageSummary } | { ok: false; error: string; usage: UsageSummary }> {
	const triagerTask = role === "triager" ? await readFile(opts.taskFile, "utf8") : undefined;
	if (ctx.signal?.aborted) return { ok: false, error: "aborted by user", usage: emptyUsage() };
	const result = await runAgent({
		role,
		spec: { label: role, model: opts.model, thinking: opts.thinking },
		promptFile: opts.promptFile,
		...(role === "triager" ? { noTools: true, stdin: triagerTask } : { taskFile: opts.taskFile }),
		cwd: ctx.cwd,
		...(role === "fixer" ? { tools: "read,grep,find,ls,bash,write,edit" } : undefined),
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

export async function runCleanup(
	backend: VcsBackend,
	cwd: string,
	confirm: (label: string, body: string) => Promise<boolean>,
	notify: (msg: string, level: "info" | "warning" | "error") => void,
	signal?: AbortSignal,
): Promise<boolean> {
	if (signal?.aborted) return false;
	if (!backend.isolation) {
		notify("Cleanup is not supported by this backend because it has no managed worktrees.", "info");
		return true;
	}
	const current = await backend.currentRef(cwd);
	if (signal?.aborted) return false;
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
			"Cleanup stops if the worktree is dirty, untracked, locked, outside Kstack's managed root, or no longer registered by Git. " +
			"Session archival is a separate manual step. This cleanup is irreversible. Continue?",
	);
	if (!confirmed || signal?.aborted) return false;

	const removed = await backend.isolation.remove(cwd, branch);
	if (!removed.ok) {
		notify(removed.error, "error");
		return false;
	}
	if (removed.warning) notify(removed.warning, "warning");

	notify("Managed worktree and branch removed. To archive the linked Pi session, run: /session-archive", "info");
	return true;
}

function parseFailureClass(raw: BoundaryValue): FailureClass {
	if (raw === "code" || raw === "stale-base" || raw === "flake" || raw === "infra" || raw === "unknown") return raw;
	return "unknown";
}

function parseDecision(raw: BoundaryValue): ThreadDecision | undefined {
	if (raw === "fix" || raw === "dismiss" || raw === "ask" || raw === "ignore") return raw;
	return undefined;
}

interface ParsedCheck {
	key: CheckTriageKey;
	cls: FailureClass;
	action: string;
}
type ParsedThread =
	| { key: ThreadTriageKey; decision: "fix"; cls: FailureClass; action: string; reply: string }
	| { key: ThreadTriageKey; decision: "dismiss"; action: string; reply: string }
	| { key: ThreadTriageKey; decision: "ask"; action: string }
	| { key: ThreadTriageKey; decision: "ignore"; action: string };

interface ParsedTriage {
	checks: ParsedCheck[];
	threads: ParsedThread[];
	conflicts: boolean;
	draft: boolean;
	summary: string;
}

function parseThreadEntry(raw: BoundaryValue): ParsedThread | undefined {
	if (!isObject(raw) || raw === null || Array.isArray(raw)) return undefined;
	const obj =
		/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ raw as JsonObject;
	const key = isString(obj.key) && isThreadTriageKey(obj.key) ? obj.key : undefined;
	if (!key) return undefined;
	const decision = parseDecision(obj.decision);
	if (!decision) return undefined;
	const action = isString(obj.action) ? obj.action : "";
	const reply = isString(obj.reply) ? obj.reply : action;
	switch (decision) {
		case "fix":
			return { key, decision, cls: parseFailureClass(obj.cls), action, reply };
		case "dismiss":
			return { key, decision, action, reply };
		case "ask":
		case "ignore":
			return { key, decision, action };
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
	let parsed: BoundaryValue;
	try {
		parsed = JSON.parse(cleaned);
	} catch (err) {
		return {
			error: `Could not parse triage JSON: ${/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (err as Error).message}`,
		};
	}
	if (!isObject(parsed) || parsed === null || Array.isArray(parsed)) {
		return { error: "Triage JSON must be an object." };
	}
	const obj =
		/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ parsed as JsonObject;
	const checksRaw = Array.isArray(obj.checks) ? obj.checks : [];
	const threadsRaw = Array.isArray(obj.threads) ? obj.threads : [];
	const checks: ParsedCheck[] = [];
	for (const item of checksRaw) {
		if (!isObject(item) || item === null || Array.isArray(item)) continue;
		const row =
			/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ item as JsonObject;
		if (!isString(row.key) || !isCheckTriageKey(row.key)) continue;
		checks.push({
			key: row.key,
			cls: parseFailureClass(row.cls),
			action: isString(row.action) ? row.action : "",
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
		summary: isString(obj.summary) ? obj.summary : "",
	};
}

/** Discard unknown record keys and force sensitive review items to ask. */
export function applyTriageGuardrails(state: PRState, parsed: ParsedTriage): ParsedTriage {
	const checks = parsed.checks.filter((check) => checkForTriageKey(state, check.key) !== undefined);
	const threads = parsed.threads.flatMap((thread) => {
		const source = threadForTriageKey(state, thread.key);
		if (!source) return [];
		if (!shouldForceAsk(source.body) || thread.decision === "ask") return [thread];
		return [
			{
				key: thread.key,
				decision: "ask" as const,
				action: thread.action || "Forced ask: sensitive or untrusted comment.",
			},
		];
	});
	const representedKeys = new Set(threads.map((thread) => thread.key));
	for (const [index, source] of state.threads.entries()) {
		if (!shouldForceAsk(source.body)) continue;
		const key = threadTriageKey(index);
		if (representedKeys.has(key)) continue;
		threads.push({ key, decision: "ask", action: "Forced ask: sensitive or untrusted comment." });
		representedKeys.add(key);
	}
	return { ...parsed, checks, threads };
}

export function summarizeTriage(triage: string): string {
	const parsed = parseTriage(triage);
	if ("error" in parsed) return "triage JSON parse failed";
	return `${parsed.checks.length} checks, ${parsed.threads.length} threads analyzed. ${parsed.summary || ""}`;
}

export async function applyThreadReplies(
	exec: ExecFn,
	cwd: string,
	state: PRState,
	parsed: ParsedTriage,
	opts: {
		resolveFix: boolean;
		pendingReviewReplies: readonly PendingReviewReply[];
		legacyPendingReplyIds: readonly string[];
		reviewMutationBlocker?: string;
		repo?: string;
	},
	notify: (msg: string, level: "info" | "warning" | "error") => void,
	signal?: AbortSignal,
): Promise<
	| { ok: true; handled: HandledReviewRecord[]; pendingReviewReplies: PendingReviewReply[] }
	| { ok: false; handled: HandledReviewRecord[]; pendingReviewReplies: PendingReviewReply[]; error: string }
> {
	const handled: HandledReviewRecord[] = [];
	let pendingReviewReplies = [...opts.pendingReviewReplies];
	const failed = (message: string) => {
		notify(message, "warning");
		return { ok: false as const, handled, pendingReviewReplies, error: message };
	};
	for (const thread of parsed.threads) {
		if (signal?.aborted) return failed("aborted by user");
		if (thread.decision === "ask") continue;
		const source = threadForTriageKey(state, thread.key);
		if (!source) continue;
		const pendingForThread = pendingReviewReplies.some((record) => record.id === source.id);
		const matchingPending = hasPendingReviewReply(pendingReviewReplies, source.id, source.version);
		if (thread.decision === "fix" && !opts.resolveFix && !matchingPending) continue;
		if (opts.reviewMutationBlocker) return failed(opts.reviewMutationBlocker);
		if (opts.legacyPendingReplyIds.includes(source.id)) {
			return failed(
				`Review thread ${source.id} has a legacy pending reply with no evidence version; inspect it before posting or resolving.`,
			);
		}
		if (thread.decision === "ignore") {
			if (source.source === "review-thread" && pendingForThread) {
				return failed(
					`Review thread ${source.id} has a pending reply; only a fresh fix or dismiss decision can resolve it.`,
				);
			}
			handled.push({ id: source.id, source: source.source, version: source.version, decision: "ignore" });
			continue;
		}
		const body =
			thread.reply.trim() ||
			(thread.decision === "dismiss"
				? `Dismissing: ${thread.action}`
				: `Addressed in a follow-up commit. ${thread.action}`);
		if (source.source === "review-thread") {
			if (!matchingPending) {
				if (source.replyToId === undefined) {
					return failed(`Could not reply to thread ${source.id}: the reply anchor is missing.`);
				}
				const appended = appendPendingReviewReply(pendingReviewReplies, {
					id: source.id,
					version: source.version,
				});
				if (!appended.ok) return failed(appended.error);
				const posted = await replyToReviewComment(exec, cwd, state.number, source.replyToId, body, opts.repo);
				if (posted.code !== 0) {
					return failed(`Could not reply to thread ${source.id}: ${commandDiagnostic(posted)}`);
				}
				pendingReviewReplies = appended.records;
			}
			if (signal?.aborted) return failed("aborted by user");
			const observed = await getReviewThread(exec, cwd, source.id, signal);
			if (observed.code !== 0 || !observed.observation) {
				return failed(`Could not inspect thread ${source.id} before resolution: ${commandDiagnostic(observed)}`);
			}
			if (observed.observation.kind === "unresolved") {
				if (observed.observation.thread.version !== source.version) {
					return failed(
						`Review thread ${source.id} changed after its reply; pending progress was kept and the new feedback needs fresh triage.`,
					);
				}
				if (signal?.aborted) return failed("aborted by user");
				const resolved = await resolveReviewThread(exec, cwd, source.id);
				if (resolved.code !== 0) {
					return failed(`Could not resolve thread ${source.id}: ${commandDiagnostic(resolved)}`);
				}
			}
			pendingReviewReplies = removePendingReviewReplies(pendingReviewReplies, source.id);
			handled.push({
				id: source.id,
				source: source.source,
				version: source.version,
				decision: thread.decision,
			});
		} else {
			const posted = await replyToIssueComment(exec, cwd, state.number, body);
			if (posted.code !== 0) {
				return failed(`Could not reply to discussion ${source.id}: ${commandDiagnostic(posted)}`);
			}
			handled.push({
				id: source.id,
				source: source.source,
				version: source.version,
				decision: thread.decision,
			});
		}
	}
	return { ok: true, handled, pendingReviewReplies };
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

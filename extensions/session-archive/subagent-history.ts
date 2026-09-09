/** Bounded refresh, search, and exact reads over retained child-session history. */
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { getSubagentSessionsRoot } from "../shared/subagent-sessions.ts";
import { formatHistoryEntries, selectHistoryPage } from "./history-page.ts";
import { MAX_TEXT_CONTENT_CHARS } from "./session-jsonl.ts";
import {
	discoverSubagentHistory,
	readStableSubagentHistoryFile,
	readStableSubagentHistoryRanges,
	revalidateSubagentHistoryFile,
	type StableSubagentRead,
	SUBAGENT_HISTORY_SESSION_BYTES,
	type SubagentFileCheck,
	type SubagentHistoryFile,
	type SubagentHistoryInventory,
	type SubagentHistorySkip,
	sameSubagentFileSignature,
} from "./subagent-history-files.ts";
import {
	deleteIndexedSubagentSessions,
	getIndexedSubagentSession,
	getSubagentHistoryDbPath,
	type IndexedSubagentSession,
	listIndexedSubagentSessions,
	openSubagentHistoryStore,
	readIndexedSubagentEntries,
	replaceIndexedSubagentSession,
	type SubagentHistorySearchHit,
	searchIndexedSubagentHistory,
} from "./subagent-history-store.ts";

const SUBAGENT_HISTORY_REFRESH_BYTES = 64 * 1024 * 1024;
const SUBAGENT_HISTORY_REFRESH_SESSIONS = 32;
const SUBAGENT_HISTORY_REFRESH_BUDGET_MS = 5_000;
const SUBAGENT_HISTORY_READ_BODY_BYTES = DEFAULT_MAX_BYTES - 8192;
const COVERAGE_REASON_LIMIT = 10;
const COVERAGE_REASON_BYTES = 240;
const SEARCH_BATCH_ROWS = 100;
const SEARCH_BATCH_LIMIT = 5;

export interface SubagentHistoryCoverage {
	complete: boolean;
	indexedSessions: number;
	pendingSessions: number;
	activeSessions: number;
	skippedSessions: number;
	skipReasons: string[];
}

interface RetainedSubagentSearchHit extends SubagentHistorySearchHit {
	path: string;
	filename: string;
}

export interface RetainedSubagentSearchResult {
	hits: RetainedSubagentSearchHit[];
	coverage: SubagentHistoryCoverage;
}

export interface SubagentHistoryReadPage {
	kind: "page";
	sessionId: string;
	path: string;
	filename: string;
	name: string | null;
	cwd: string;
	createdAt: string;
	format: "normalized" | "raw";
	offset: number;
	limit: number;
	totalEntries: number;
	pageEntries: number;
	firstOrdinal: number | null;
	lastOrdinal: number | null;
	chunk: number;
	chunks: number;
	body: string;
	next: { offset: number; chunk: number } | null;
	textContentLimitChars: number;
}

type SubagentHistoryReadResult =
	| SubagentHistoryReadPage
	| { kind: "active"; sessionId: string; message: string }
	| { kind: "unavailable"; sessionId: string; message: string; retryable: boolean }
	| { kind: "invalid"; sessionId: string; message: string };

interface HistoryLimits {
	maxSessionBytes?: number;
	refreshBytes?: number;
	refreshSessions?: number;
	refreshBudgetMs?: number;
	readBodyBytes?: number;
}

interface HistoryDependencies {
	discover?: typeof discoverSubagentHistory;
	readStable?: typeof readStableSubagentHistoryFile;
	readRanges?: typeof readStableSubagentHistoryRanges;
	revalidate?: typeof revalidateSubagentHistoryFile;
	now?: () => number;
}

interface HistoryOptions {
	sourceRoot?: string;
	dbPath?: string;
	limits?: HistoryLimits;
	deps?: HistoryDependencies;
	isPidAlive?: (pid: number) => boolean;
}

interface RefreshState {
	inventory: SubagentHistoryInventory;
	coverage: SubagentHistoryCoverage;
	filesById: Map<string, SubagentHistoryFile>;
	outcomes: Map<string, Exclude<StableSubagentRead, { kind: "read" }> | { kind: "deferred" }>;
}

function boundedReason(reason: string): string {
	const normalized = reason.replaceAll(/\s+/g, " ").trim();
	const bytes = Buffer.from(normalized);
	if (bytes.length <= COVERAGE_REASON_BYTES) return normalized;
	return `${Buffer.from(bytes.subarray(0, COVERAGE_REASON_BYTES)).toString("utf8").replaceAll("�", "")}…`;
}

function skipLabel(skip: SubagentHistorySkip): string {
	const subject = skip.sessionId ?? skip.filename ?? "history source";
	return boundedReason(`${subject}: ${skip.reason}${skip.retryable ? " (retryable)" : ""}`);
}

function skippedSessionCount(skips: SubagentHistorySkip[]): number {
	const identified = new Set(skips.flatMap((skip) => (skip.sessionId ? [skip.sessionId] : [])));
	return identified.size + skips.filter((skip) => skip.sessionId === undefined).length;
}

function matchingRow(row: IndexedSubagentSession | undefined, file: SubagentHistoryFile): boolean {
	return (
		row !== undefined &&
		row.relativeFilename === file.filename &&
		sameSubagentFileSignature(row.signature, file.signature)
	);
}

function coverageFrom(options: {
	inventory: SubagentHistoryInventory;
	rows: IndexedSubagentSession[];
	extraSkips: SubagentHistorySkip[];
}): SubagentHistoryCoverage {
	const rowsById = new Map(options.rows.map((row) => [row.sessionId, row]));
	const skips = [...options.inventory.skipped, ...options.extraSkips];
	const excludedIds = new Set([
		...options.inventory.activeSessionIds,
		...skips.flatMap((skip) => (skip.sessionId ? [skip.sessionId] : [])),
	]);
	const indexableFiles = options.inventory.files.filter((file) => !excludedIds.has(file.sessionId));
	const indexedSessions = indexableFiles.filter((file) => matchingRow(rowsById.get(file.sessionId), file)).length;
	const pendingSessions = indexableFiles.length - indexedSessions;
	const reasons = skips.map(skipLabel).slice(0, COVERAGE_REASON_LIMIT);
	if (skips.length > reasons.length) reasons.push(`…and ${skips.length - reasons.length} more bounded skip reason(s)`);
	const skippedSessions = skippedSessionCount(skips);
	return {
		complete: options.inventory.complete && pendingSessions === 0 && skippedSessions === 0,
		indexedSessions,
		pendingSessions,
		activeSessions: new Set(options.inventory.activeSessionIds).size,
		skippedSessions,
		skipReasons: reasons,
	};
}

type RefreshFailureClassification =
	| { kind: "active" }
	| { kind: "pending" }
	| { kind: "skip"; skip: SubagentHistorySkip };

function classifyRefreshFailure(
	failure: Exclude<StableSubagentRead, { kind: "read" }>,
	file: SubagentHistoryFile,
): RefreshFailureClassification {
	if (failure.kind === "active") return { kind: "active" };
	if (failure.kind === "changed") return { kind: "pending" };
	return {
		kind: "skip",
		skip: {
			sessionId: file.sessionId,
			filename: file.filename,
			reason: failure.reason,
			retryable: failure.kind === "unavailable",
		},
	};
}

function checkFailureResult(
	sessionId: string,
	check: Exclude<SubagentFileCheck, { kind: "eligible" }>,
): SubagentHistoryReadResult {
	if (check.kind === "active") {
		return {
			kind: "active",
			sessionId,
			message:
				"This retained child session is active or its lease state is uncertain. Try again after the child exits.",
		};
	}
	if (check.kind === "invalid") return { kind: "invalid", sessionId, message: boundedReason(check.reason) };
	return {
		kind: "unavailable",
		sessionId,
		message:
			check.kind === "changed"
				? "The retained source changed while it was being read. Repeat the read to refresh it."
				: "The retained source is unavailable. It may have expired, moved, or been removed.",
		retryable: check.kind === "changed",
	};
}

export function createSubagentHistory(options: HistoryOptions = {}) {
	const sourceRoot = resolve(options.sourceRoot ?? getSubagentSessionsRoot());
	const dbPath = options.dbPath ?? getSubagentHistoryDbPath();
	const discover = options.deps?.discover ?? discoverSubagentHistory;
	const readStable = options.deps?.readStable ?? readStableSubagentHistoryFile;
	const readRanges = options.deps?.readRanges ?? readStableSubagentHistoryRanges;
	const revalidate = options.deps?.revalidate ?? revalidateSubagentHistoryFile;
	const now = options.deps?.now ?? Date.now;
	const maxSessionBytes = options.limits?.maxSessionBytes ?? SUBAGENT_HISTORY_SESSION_BYTES;
	const refreshBytes = options.limits?.refreshBytes ?? SUBAGENT_HISTORY_REFRESH_BYTES;
	const refreshSessions = options.limits?.refreshSessions ?? SUBAGENT_HISTORY_REFRESH_SESSIONS;
	const refreshBudgetMs = options.limits?.refreshBudgetMs ?? SUBAGENT_HISTORY_REFRESH_BUDGET_MS;
	const readBodyBytes = options.limits?.readBodyBytes ?? SUBAGENT_HISTORY_READ_BODY_BYTES;

	const fileOptions = (signal: AbortSignal | undefined) => ({
		root: sourceRoot,
		maxSessionBytes,
		isPidAlive: options.isPidAlive,
		signal,
	});

	async function refresh(
		db: DatabaseSync,
		signal: AbortSignal | undefined,
		targetSessionId?: string,
	): Promise<RefreshState> {
		signal?.throwIfAborted();
		const inventory = await discover({ ...fileOptions(signal), leaseCheckSessionId: targetSessionId });
		const filesById = new Map(inventory.files.map((file) => [file.sessionId, file]));
		const rows = listIndexedSubagentSessions(db);
		const existingRowsById = new Map(rows.map((row) => [row.sessionId, row]));
		const ineligibleIds = new Set([
			...inventory.activeSessionIds,
			...inventory.skipped.flatMap((skip) => (skip.sessionId ? [skip.sessionId] : [])),
		]);
		const deleteIds = new Set<string>(ineligibleIds);
		if (inventory.complete) {
			for (const row of rows) {
				if (!filesById.has(row.sessionId)) deleteIds.add(row.sessionId);
			}
		}
		for (const file of inventory.files) {
			const row = existingRowsById.get(file.sessionId);
			if (row && !matchingRow(row, file)) deleteIds.add(row.sessionId);
		}
		deleteIndexedSubagentSessions(db, [...deleteIds]);

		const currentRows = listIndexedSubagentSessions(db);
		const rowsById = new Map(currentRows.map((row) => [row.sessionId, row]));
		let pending = inventory.files.filter((file) => !matchingRow(rowsById.get(file.sessionId), file));
		if (targetSessionId !== undefined) pending = pending.filter((file) => file.sessionId === targetSessionId);
		const outcomes: RefreshState["outcomes"] = new Map();
		const extraSkips: SubagentHistorySkip[] = [];
		const active = new Set(inventory.activeSessionIds);
		let processedSessions = 0;
		let processedBytes = 0;
		const deadline = now() + refreshBudgetMs;

		for (const file of pending) {
			signal?.throwIfAborted();
			if (
				processedSessions >= refreshSessions ||
				processedBytes + file.signature.size > refreshBytes ||
				now() >= deadline
			) {
				outcomes.set(file.sessionId, { kind: "deferred" });
				continue;
			}
			if (file.signature.size > maxSessionBytes) {
				const failure = {
					kind: "invalid" as const,
					reason: `source exceeds the ${maxSessionBytes}-byte per-session limit`,
				};
				outcomes.set(file.sessionId, failure);
				extraSkips.push({
					sessionId: file.sessionId,
					filename: file.filename,
					reason: failure.reason,
					retryable: false,
				});
				continue;
			}
			processedSessions++;
			processedBytes += file.signature.size;
			const stable = await readStable(file, fileOptions(signal));
			if (stable.kind !== "read") {
				outcomes.set(file.sessionId, stable);
				const classified = classifyRefreshFailure(stable, file);
				if (classified.kind === "active") active.add(file.sessionId);
				else if (classified.kind === "skip") extraSkips.push(classified.skip);
				continue;
			}
			signal?.throwIfAborted();
			replaceIndexedSubagentSession(db, {
				sessionId: file.sessionId,
				header: stable.parsed.header,
				entries: stable.parsed.entries,
				relativeFilename: file.filename,
				signature: file.signature,
				name: stable.name,
			});
		}

		inventory.activeSessionIds = [...active].sort();
		const finalRows = listIndexedSubagentSessions(db);
		return {
			inventory,
			coverage: coverageFrom({ inventory, rows: finalRows, extraSkips }),
			filesById,
			outcomes,
		};
	}

	async function search(
		params: { query: string; cwd?: string; role?: string; sessionId?: string; limit?: number },
		signal?: AbortSignal,
	): Promise<RetainedSubagentSearchResult> {
		const db = openSubagentHistoryStore(dbPath);
		try {
			const state = await refresh(db, signal);
			signal?.throwIfAborted();
			const limit = params.limit ?? 20;
			const checks = new Map<string, SubagentFileCheck>();
			const invalidated = new Set<string>();
			const accepted: RetainedSubagentSearchHit[] = [];
			// Page through ranked rows in bounded batches so invalidated hits do not under-fill the result.
			for (let batch = 0; batch < SEARCH_BATCH_LIMIT && accepted.length < limit; batch++) {
				signal?.throwIfAborted();
				const rawHits = searchIndexedSubagentHistory(db, {
					...params,
					limit: SEARCH_BATCH_ROWS,
					offset: batch * SEARCH_BATCH_ROWS,
				});
				for (const hit of rawHits) {
					if (accepted.length >= limit) break;
					const file = state.filesById.get(hit.sessionId);
					if (!file) {
						if (state.inventory.complete) invalidated.add(hit.sessionId);
						continue;
					}
					if (file.filename !== hit.relativeFilename) {
						invalidated.add(hit.sessionId);
						continue;
					}
					let check = checks.get(hit.sessionId);
					if (!check) {
						check = await revalidate(file, fileOptions(signal));
						checks.set(hit.sessionId, check);
					}
					if (check.kind !== "eligible") {
						invalidated.add(hit.sessionId);
						continue;
					}
					accepted.push({ ...hit, path: file.path, filename: file.filename });
				}
				if (rawHits.length < SEARCH_BATCH_ROWS) break;
			}
			if (invalidated.size > 0) {
				deleteIndexedSubagentSessions(db, [...invalidated]);
				const rows = listIndexedSubagentSessions(db);
				state.coverage = coverageFrom({
					inventory: state.inventory,
					rows,
					extraSkips: [...invalidated].map((sessionId) => ({
						sessionId,
						reason: "source became ineligible while search results were validated",
						retryable: true,
					})),
				});
			}
			return { hits: accepted, coverage: state.coverage };
		} finally {
			db.close();
		}
	}

	async function read(
		params: {
			sessionId: string;
			offset?: number;
			limit?: number;
			format?: "normalized" | "raw";
			chunk?: number;
		},
		signal?: AbortSignal,
	): Promise<SubagentHistoryReadResult> {
		const db = openSubagentHistoryStore(dbPath);
		try {
			const state = await refresh(db, signal, params.sessionId);
			if (state.inventory.activeSessionIds.includes(params.sessionId)) {
				return {
					kind: "active",
					sessionId: params.sessionId,
					message: "This retained child session is still active or its lease state is uncertain.",
				};
			}
			const file = state.filesById.get(params.sessionId);
			if (!file) {
				const invalid = state.inventory.skipped.find((skip) => skip.sessionId === params.sessionId);
				if (invalid) return { kind: "invalid", sessionId: params.sessionId, message: boundedReason(invalid.reason) };
				return {
					kind: "unavailable",
					sessionId: params.sessionId,
					message: state.inventory.complete
						? "No retained source is currently available for this session ID. It may have expired or been removed."
						: "The retained source was not found within the bounded directory scan. Repeat after reducing directory pressure.",
					retryable: !state.inventory.complete,
				};
			}
			const outcome = state.outcomes.get(params.sessionId);
			if (outcome?.kind === "deferred") {
				return {
					kind: "unavailable",
					sessionId: params.sessionId,
					message: "The refresh work budget was reached before this source could be indexed. Repeat the read.",
					retryable: true,
				};
			}
			if (outcome) return checkFailureResult(params.sessionId, outcome);
			const session = getIndexedSubagentSession(db, params.sessionId);
			if (!session || !matchingRow(session, file)) {
				return {
					kind: "unavailable",
					sessionId: params.sessionId,
					message: "The retained source could not be indexed stably. Repeat the read.",
					retryable: true,
				};
			}

			const offset = params.offset ?? 0;
			const limit = params.limit ?? 50;
			const format = params.format ?? "normalized";
			const entries = readIndexedSubagentEntries(db, params.sessionId, offset, limit);
			let body: string;
			if (format === "raw") {
				const rangeRead = await readRanges(
					file,
					entries.map((entry) => ({ offset: entry.rawOffset, length: entry.rawLength })),
					fileOptions(signal),
				);
				if (rangeRead.kind !== "read") {
					deleteIndexedSubagentSessions(db, [params.sessionId]);
					return checkFailureResult(params.sessionId, rangeRead);
				}
				body = rangeRead.ranges.join("\n");
			} else {
				body = formatHistoryEntries(entries);
			}
			const page = selectHistoryPage({
				body,
				offset,
				pageEntries: entries.length,
				totalEntries: session.entryCount,
				chunk: params.chunk ?? 0,
				maxBytes: readBodyBytes,
			});
			if (!page.ok) {
				return { kind: "invalid", sessionId: params.sessionId, message: page.reason };
			}
			const check = await revalidate(file, fileOptions(signal));
			if (check.kind !== "eligible") {
				deleteIndexedSubagentSessions(db, [params.sessionId]);
				return checkFailureResult(params.sessionId, check);
			}
			return {
				kind: "page",
				sessionId: session.sessionId,
				path: join(sourceRoot, session.relativeFilename),
				filename: session.relativeFilename,
				name: session.name,
				cwd: session.cwd,
				createdAt: session.createdAt,
				format,
				offset,
				limit,
				totalEntries: session.entryCount,
				pageEntries: entries.length,
				firstOrdinal: entries.at(0)?.ordinal ?? null,
				lastOrdinal: entries.at(-1)?.ordinal ?? null,
				chunk: page.chunk,
				chunks: page.chunks,
				body: page.body,
				next: page.next,
				textContentLimitChars: MAX_TEXT_CONTENT_CHARS,
			};
		} finally {
			db.close();
		}
	}

	return { search, read };
}

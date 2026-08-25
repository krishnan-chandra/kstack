import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { BoundaryValue } from "../shared/validation.ts";
import { archiveDestination, chmodReadOnly, hashFile, validateSessionId } from "./archive-files.ts";
import {
	finalizeArchived,
	getSessionRow,
	importSessionPending,
	listRestoreJournals,
	openArchiveDb,
} from "./archive-store.ts";
import { type ParsedEntry, type ParsedSessionHeader, parseSessionJsonlBytes, sha256Hex } from "./session-jsonl.ts";

export interface RebuildCandidate {
	sessionId: string;
	artifactPath: string;
	fileSize: number;
	sha256: string;
	header: ParsedSessionHeader;
	entries: ParsedEntry[];
}

/* exported: session archive rebuild plan contract */
export interface RebuildPlan {
	toIndex: RebuildCandidate[];
	alreadyIndexed: string[];
	conflicts: Array<{ sessionId: string; artifactPath: string; reason: string }>;
	needsReconcile: Array<{ sessionId: string; state: string }>;
	invalid: Array<{ artifactPath: string; reason: string }>;
}

interface DirectoryEntry {
	name: string;
	isDirectory(): boolean;
	isFile(): boolean;
}

interface PlanRebuildOptions {
	archiveRoot: string;
	dbPath: string;
	readFile?: (path: string) => Buffer;
	readDirectory?: (path: string) => DirectoryEntry[];
	openDb?: typeof openArchiveDb;
}

function errorMessage(error: BoundaryValue): string {
	return error instanceof Error ? error.message : String(error);
}

function readDirectoryIfPresent(path: string): DirectoryEntry[] {
	try {
		return readdirSync(path, { withFileTypes: true });
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}

function artifactPaths(archiveRoot: string, readDirectory: (path: string) => DirectoryEntry[]): string[] {
	const sessionsRoot = join(archiveRoot, "sessions");
	const paths: string[] = [];
	for (const year of readDirectory(sessionsRoot)) {
		if (!year.isDirectory()) continue;
		const yearPath = join(sessionsRoot, year.name);
		for (const month of readDirectory(yearPath)) {
			if (!month.isDirectory()) continue;
			const monthPath = join(yearPath, month.name);
			for (const session of readDirectory(monthPath)) {
				if (!session.isDirectory()) continue;
				const sessionPath = join(monthPath, session.name);
				const artifact = readDirectory(sessionPath).find((entry) => entry.name === "session.jsonl" && entry.isFile());
				if (artifact) paths.push(join(sessionPath, artifact.name));
			}
		}
	}
	return paths.sort((left, right) => left.localeCompare(right));
}

/** Scan canonical JSONL artifacts and classify their current index state without changing artifact bytes. */
export function planRebuild(options: PlanRebuildOptions): RebuildPlan {
	const plan: RebuildPlan = {
		toIndex: [],
		alreadyIndexed: [],
		conflicts: [],
		needsReconcile: [],
		invalid: [],
	};
	const readFile = options.readFile ?? readFileSync;
	const readDirectory = options.readDirectory ?? readDirectoryIfPresent;
	const db = (options.openDb ?? openArchiveDb)(options.dbPath);
	try {
		const restoring = new Set(listRestoreJournals(db).map((row) => row.session_id));
		for (const artifactPath of artifactPaths(options.archiveRoot, readDirectory)) {
			const sessionId = basename(dirname(artifactPath));
			try {
				validateSessionId(sessionId);
				const bytes = readFile(artifactPath);
				const parsed = parseSessionJsonlBytes(bytes);
				if (parsed.header.id !== sessionId) {
					plan.invalid.push({
						artifactPath,
						reason: `header session id ${parsed.header.id} does not match directory id ${sessionId}`,
					});
					continue;
				}
				const canonicalPath = archiveDestination(options.archiveRoot, sessionId, parsed.header.timestamp);
				if (resolve(artifactPath) !== resolve(canonicalPath)) {
					plan.invalid.push({ artifactPath, reason: "artifact not at its canonical destination" });
					continue;
				}
				const candidate: RebuildCandidate = {
					sessionId,
					artifactPath,
					fileSize: bytes.length,
					sha256: sha256Hex(bytes),
					header: parsed.header,
					entries: parsed.entries,
				};
				if (restoring.has(sessionId)) {
					plan.needsReconcile.push({ sessionId, state: "restore" });
					continue;
				}
				const row = getSessionRow(db, sessionId);
				if (!row) {
					plan.toIndex.push(candidate);
				} else if (row.state === "archived") {
					if (row.sha256 === candidate.sha256 && row.archive_path === candidate.artifactPath) {
						plan.alreadyIndexed.push(sessionId);
					} else {
						plan.conflicts.push({
							sessionId,
							artifactPath,
							reason: "existing archived row has different content or destination",
						});
					}
				} else {
					plan.needsReconcile.push({ sessionId, state: row.state });
				}
			} catch (error) {
				plan.invalid.push({ artifactPath, reason: errorMessage(error) });
			}
		}
	} finally {
		db.close();
	}
	return plan;
}

/** Reconstruct the path Pi would have assigned from the session header. */
export function deriveOriginalPath(activeSessionsRoot: string, header: ParsedSessionHeader): string {
	validateSessionId(header.id);
	const timestamp = new Date(header.timestamp);
	if (Number.isNaN(timestamp.getTime()))
		throw new Error(`invalid session timestamp: ${JSON.stringify(header.timestamp)}`);
	const resolvedCwd = resolve(header.cwd);
	const safeCwd = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const fileTimestamp = timestamp.toISOString().replace(/[:.]/g, "-");
	return join(resolve(activeSessionsRoot), safeCwd, `${fileTimestamp}_${header.id}.jsonl`);
}

/* exported: session archive rebuild result contract */
export interface RebuildResult {
	indexed: string[];
	failed: Array<{ sessionId: string; error: string }>;
}

/** Add every planned artifact to the index and re-mark it read-only, isolating failures by session. */
export function applyRebuild(
	db: DatabaseSync,
	plan: RebuildPlan,
	originalPathFor: (header: ParsedSessionHeader) => string,
): RebuildResult {
	const result: RebuildResult = { indexed: [], failed: [] };
	for (const candidate of plan.toIndex) {
		try {
			const current = hashFile(candidate.artifactPath);
			if (current.size !== candidate.fileSize || current.sha256 !== candidate.sha256) {
				throw new Error("artifact changed after the rebuild plan was created");
			}
			importSessionPending(db, {
				header: candidate.header,
				entries: candidate.entries,
				originalPath: originalPathFor(candidate.header),
				archivePath: candidate.artifactPath,
				fileSize: candidate.fileSize,
				sha256: candidate.sha256,
			});
			// Backup-recovered artifacts may have lost the archive's read-only mode;
			// restore it before finalizing, matching archive-ops and reconcile.
			chmodReadOnly(candidate.artifactPath);
			finalizeArchived(db, candidate.sessionId, candidate.artifactPath, candidate.fileSize, candidate.sha256);
			result.indexed.push(candidate.sessionId);
		} catch (error) {
			result.failed.push({ sessionId: candidate.sessionId, error: errorMessage(error) });
		}
	}
	return result;
}

interface RebuildCommandContext {
	hasUI: boolean;
	waitForIdle(): Promise<void>;
	ui: {
		confirm(title: string, message: string): Promise<boolean>;
		notify(message: string, level: "info" | "warning" | "error"): void;
	};
}

interface RebuildCommandDeps {
	archiveRoot: string;
	activeSessionsRoot: string;
	dbPath: string;
	planRebuild: typeof planRebuild;
	openArchiveDb: typeof openArchiveDb;
	applyRebuild: typeof applyRebuild;
}

function boundedExample(value: string): string {
	return value.length <= 160 ? value : `${value.slice(0, 159)}…`;
}

function appendExamples(lines: string[], label: string, values: string[]): void {
	if (values.length === 0) return;
	lines.push(`${label}: ${values.slice(0, 10).map(boundedExample).join(", ")}`);
	if (values.length > 10) lines.push(`…and ${values.length - 10} more ${label.toLowerCase()}.`);
}

function confirmationSummary(plan: RebuildPlan): string {
	const lines = [
		`${plan.toIndex.length} to index; ${plan.alreadyIndexed.length} already indexed; ` +
			`${plan.conflicts.length} conflict(s); ${plan.needsReconcile.length} needing reconciliation; ` +
			`${plan.invalid.length} invalid.`,
	];
	appendExamples(
		lines,
		"Conflicts",
		plan.conflicts.map((item) => item.sessionId),
	);
	appendExamples(
		lines,
		"Needs reconciliation",
		plan.needsReconcile.map((item) => item.sessionId),
	);
	appendExamples(
		lines,
		"Invalid artifacts",
		plan.invalid.map((item) => item.artifactPath),
	);
	return lines.join("\n");
}

/** Build the confirmation-gated user command around the deterministic rebuild operations. */
export function createRebuildCommand(deps: RebuildCommandDeps) {
	return async (_args: string, ctx: RebuildCommandContext): Promise<void> => {
		if (!ctx.hasUI) {
			ctx.ui.notify("/session-archive-rebuild requires interactive TUI or RPC mode.", "error");
			return;
		}
		await ctx.waitForIdle();
		try {
			const plan = deps.planRebuild({ archiveRoot: deps.archiveRoot, dbPath: deps.dbPath });
			const anomalous = plan.conflicts.length + plan.needsReconcile.length + plan.invalid.length;
			if (plan.toIndex.length === 0 && anomalous === 0) {
				ctx.ui.notify(`Archive index is complete: ${plan.alreadyIndexed.length} artifacts, all indexed.`, "info");
				return;
			}
			const confirmed = await ctx.ui.confirm("Rebuild session archive index?", confirmationSummary(plan));
			if (!confirmed) return;
			const db = deps.openArchiveDb(deps.dbPath);
			let result: RebuildResult;
			try {
				result = deps.applyRebuild(db, plan, (header) => deriveOriginalPath(deps.activeSessionsRoot, header));
			} finally {
				db.close();
			}
			const summary =
				`Archive rebuild complete: ${result.indexed.length} indexed, ${plan.alreadyIndexed.length} already indexed (skipped), ` +
				`${plan.conflicts.length} conflicts, ${plan.needsReconcile.length} needing reconciliation, ` +
				`${plan.invalid.length} invalid, ${result.failed.length} failed.`;
			const reminder =
				plan.conflicts.length + plan.needsReconcile.length > 0
					? " Run /sessions to inspect conflicts and reconciliation states."
					: "";
			ctx.ui.notify(summary + reminder, anomalous + result.failed.length > 0 ? "warning" : "info");
		} catch (error) {
			ctx.ui.notify(`Session archive rebuild failed: ${errorMessage(error)}`, "error");
		}
	};
}

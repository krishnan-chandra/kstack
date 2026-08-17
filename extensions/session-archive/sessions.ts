import { sanitizeDisplayText } from "../shared/terminal-text.ts";
import { pathsReferToSameFile } from "./archive-files.ts";
import type { ArchivedSessionSummary } from "./archive-store.ts";

export interface ActiveSessionInfo {
	id: string;
	path: string;
	cwd: string;
	name?: string;
	firstMessage?: string;
	modified: Date;
	created: Date;
}

export type SessionRow =
	| {
			kind: "active";
			id: string;
			path: string;
			cwd: string;
			name?: string;
			firstMessage?: string;
			modified: Date;
			created: Date;
			current: boolean;
			label: string;
	  }
	| {
			kind: "archived";
			id: string;
			path: string;
			cwd: string;
			name?: string;
			firstMessage?: string;
			modified: Date;
			created: Date;
			current: false;
			label: string;
	  }
	| {
			kind: "error";
			id: string;
			path: string;
			cwd: string;
			name?: string;
			firstMessage?: string;
			modified: Date;
			created: Date;
			current: false;
			label: string;
			detail: string;
	  };

function boundedLabel(name: string | undefined, firstMessage: string | undefined, id: string): string {
	const source = name ?? firstMessage ?? id.slice(0, 8);
	const value = sanitizeDisplayText(source);
	return value.length > 72 ? `${value.slice(0, 71)}…` : value;
}

function dateOrFallback(value: string | null, fallback: string): Date {
	const parsed = Date.parse(value ?? fallback);
	return new Date(Number.isFinite(parsed) ? parsed : 0);
}

/** Merge current Pi session metadata with archived and recovery-error catalog summaries. */
export function buildSessionRows(
	active: ActiveSessionInfo[],
	archived: ArchivedSessionSummary[],
	currentPath?: string,
): SessionRow[] {
	const rows = new Map<string, SessionRow>();
	for (const session of active) {
		const name = session.name ? sanitizeDisplayText(session.name) : undefined;
		const firstMessage = session.firstMessage ? sanitizeDisplayText(session.firstMessage) : undefined;
		rows.set(session.id, {
			kind: "active",
			id: session.id,
			path: session.path,
			cwd: sanitizeDisplayText(session.cwd),
			name,
			firstMessage,
			modified: session.modified,
			created: session.created,
			current:
				currentPath !== undefined && (session.path === currentPath || pathsReferToSameFile(session.path, currentPath)),
			label: boundedLabel(name, firstMessage, session.id),
		});
	}
	for (const session of archived) {
		if (rows.has(session.sessionId) && session.state === "archived") continue;
		const created = dateOrFallback(session.createdAt, session.createdAt);
		const modified = dateOrFallback(session.lastMessageAt, session.createdAt);
		const name = session.name ? sanitizeDisplayText(session.name) : undefined;
		const firstMessage = session.firstUserText ? sanitizeDisplayText(session.firstUserText) : undefined;
		const common = {
			id: session.sessionId,
			path: session.originalPath,
			cwd: sanitizeDisplayText(session.cwd),
			name,
			firstMessage,
			modified,
			created,
			current: false as const,
			label: boundedLabel(name, firstMessage, session.sessionId),
		};
		if (session.state === "archived") {
			rows.set(session.sessionId, { ...common, kind: "archived" });
		} else {
			const error = sanitizeDisplayText(session.lastError ?? "unknown archive recovery error");
			const archivePath = session.archivePath ? sanitizeDisplayText(session.archivePath) : "(none recorded)";
			rows.set(session.sessionId, {
				...common,
				kind: "error",
				detail: [
					`Session: ${session.sessionId}`,
					`Error: ${error}`,
					`Original path: ${sanitizeDisplayText(session.originalPath)}`,
					`Archive path: ${archivePath}`,
					"Both paths are preserved when present. Resolve the file mismatch, then restart Pi or reopen /sessions.",
				].join("\n"),
			});
		}
	}
	return [...rows.values()].sort(
		(left, right) =>
			right.modified.getTime() - left.modified.getTime() ||
			right.created.getTime() - left.created.getTime() ||
			left.id.localeCompare(right.id),
	);
}

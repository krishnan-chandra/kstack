import { stripTerminalSequences } from "@earendil-works/pi-tui";
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
	  };

function sanitizeSessionText(value: string): string {
	return stripTerminalSequences(value)
		.replace(
			// biome-ignore lint/suspicious/noControlCharactersInRegex: remove terminal control characters
			/[\x00-\x1f\x7f-\x9f]+/g,
			" ",
		)
		.replace(/\s+/g, " ")
		.trim();
}

function boundedLabel(name: string | undefined, firstMessage: string | undefined, id: string): string {
	const source = name ?? firstMessage ?? id.slice(0, 8);
	const value = sanitizeSessionText(source);
	return value.length > 72 ? `${value.slice(0, 71)}…` : value;
}

function dateOrFallback(value: string | null, fallback: string): Date {
	const parsed = Date.parse(value ?? fallback);
	return new Date(Number.isFinite(parsed) ? parsed : 0);
}

/** Merge current Pi session metadata and finalized archive summaries by session id. */
export function buildSessionRows(
	active: ActiveSessionInfo[],
	archived: ArchivedSessionSummary[],
	currentPath?: string,
): SessionRow[] {
	const rows = new Map<string, SessionRow>();
	for (const session of active) {
		const name = session.name ? sanitizeSessionText(session.name) : undefined;
		const firstMessage = session.firstMessage ? sanitizeSessionText(session.firstMessage) : undefined;
		rows.set(session.id, {
			kind: "active",
			id: session.id,
			path: session.path,
			cwd: sanitizeSessionText(session.cwd),
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
		if (rows.has(session.sessionId)) continue;
		const created = dateOrFallback(session.createdAt, session.createdAt);
		const modified = dateOrFallback(session.lastMessageAt, session.createdAt);
		const name = session.name ? sanitizeSessionText(session.name) : undefined;
		const firstMessage = session.firstUserText ? sanitizeSessionText(session.firstUserText) : undefined;
		rows.set(session.sessionId, {
			kind: "archived",
			id: session.sessionId,
			path: session.originalPath,
			cwd: sanitizeSessionText(session.cwd),
			name,
			firstMessage,
			modified,
			created,
			current: false,
			label: boundedLabel(name, firstMessage, session.sessionId),
		});
	}
	return [...rows.values()].sort(
		(left, right) =>
			right.modified.getTime() - left.modified.getTime() ||
			right.created.getTime() - left.created.getTime() ||
			left.id.localeCompare(right.id),
	);
}

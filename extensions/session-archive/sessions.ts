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

function boundedLabel(name: string | undefined, firstMessage: string | undefined, id: string): string {
	const value = (name ?? firstMessage ?? id.slice(0, 8)).replace(/\s+/g, " ").trim();
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
		rows.set(session.id, {
			kind: "active",
			id: session.id,
			path: session.path,
			cwd: session.cwd,
			name: session.name,
			firstMessage: session.firstMessage,
			modified: session.modified,
			created: session.created,
			current: session.path === currentPath,
			label: boundedLabel(session.name, session.firstMessage, session.id),
		});
	}
	for (const session of archived) {
		if (rows.has(session.sessionId)) continue;
		const created = dateOrFallback(session.createdAt, session.createdAt);
		const modified = dateOrFallback(session.lastMessageAt, session.createdAt);
		rows.set(session.sessionId, {
			kind: "archived",
			id: session.sessionId,
			path: session.originalPath,
			cwd: session.cwd,
			name: session.name ?? undefined,
			firstMessage: session.firstUserText ?? undefined,
			modified,
			created,
			current: false,
			label: boundedLabel(session.name ?? undefined, session.firstUserText ?? undefined, session.sessionId),
		});
	}
	return [...rows.values()].sort(
		(left, right) =>
			right.modified.getTime() - left.modified.getTime() ||
			right.created.getTime() - left.created.getTime() ||
			left.id.localeCompare(right.id),
	);
}

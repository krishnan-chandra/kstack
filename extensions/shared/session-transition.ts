import { randomUUID } from "node:crypto";
import { type BoundaryValue, isObject, isString } from "./validation.ts";

export type SessionTransitionKind = "handoff" | "archive_session";

interface PendingTransitionEntry {
	kind: SessionTransitionKind;
	token: string;
}

// Pi can load extensions through isolated module graphs. Symbol.for ensures
// handoff and session-archive coordinate session-ending tool transitions
// within the same session without double-replacing a newly created session.
const PENDING_TRANSITIONS = Symbol.for("kstack.pending-session-transitions.v1");

function getRegistry(): Map<BoundaryValue, BoundaryValue> {
	const current: BoundaryValue = Object.getOwnPropertyDescriptor(globalThis, PENDING_TRANSITIONS)?.value;
	if (current instanceof Map) return current;
	const created = new Map<BoundaryValue, BoundaryValue>();
	Object.defineProperty(globalThis, PENDING_TRANSITIONS, { configurable: true, value: created });
	return created;
}

function readEntry(value: BoundaryValue): PendingTransitionEntry | undefined {
	if (!isObject(value) || value === null) return undefined;
	const kind: BoundaryValue = Object.getOwnPropertyDescriptor(value, "kind")?.value;
	const token: BoundaryValue = Object.getOwnPropertyDescriptor(value, "token")?.value;
	if ((kind !== "handoff" && kind !== "archive_session") || !isString(token) || token.length === 0) {
		return undefined;
	}
	return { kind, token };
}

/**
 * Claim the single pending session-replacement slot for `sessionId`.
 * Returns a secret one-time token, or `undefined` when a transition is
 * already scheduled for that session.
 */
export function claimSessionTransition(sessionId: string, kind: SessionTransitionKind): string | undefined {
	const registry = getRegistry();
	if (registry.has(sessionId)) return undefined;
	const token = randomUUID();
	registry.set(sessionId, { kind, token });
	return token;
}

/** Validate and consume a pending transition token for `sessionId` and `kind`. */
export function consumeSessionTransition(sessionId: string, kind: SessionTransitionKind, token: string): boolean {
	const registry = getRegistry();
	const entry = readEntry(registry.get(sessionId));
	if (!entry || entry.kind !== kind || entry.token !== token) return false;
	registry.delete(sessionId);
	return true;
}

/** Release a pending transition slot for `sessionId` (optionally matching `token`). */
export function releaseSessionTransition(sessionId: string, token?: string): void {
	const registry = getRegistry();
	if (token === undefined) {
		registry.delete(sessionId);
		return;
	}
	const entry = readEntry(registry.get(sessionId));
	if (entry?.token === token) registry.delete(sessionId);
}

/** Parse an internal `--tool-token=<token>` command argument. */
export function parseToolTokenArg(args: string): string | undefined {
	const trimmed = args.trim();
	const prefix = "--tool-token=";
	if (!trimmed.startsWith(prefix)) return undefined;
	const token = trimmed.slice(prefix.length);
	if (token.length === 0 || /\s/.test(token)) return undefined;
	return token;
}

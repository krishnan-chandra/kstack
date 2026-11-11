/** Sidecar state file written by hosted Pi agents so backends without a session
 * registry (such as Rex) can verify live process identity and read the active
 * Pi session JSONL path.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { type BoundaryValue, isNumber, isObject, isString, type JsonObject } from "../validation.ts";

export const KSTACK_HOSTED_AGENT_STATE_ENV = "KSTACK_HOSTED_AGENT_STATE";
export const KSTACK_HOSTED_AGENT_NAME_ENV = "KSTACK_HOSTED_AGENT_NAME";

export interface HostedAgentState {
	version: 1;
	name: string;
	pid: number;
	cwd: string;
	sessionFile?: string;
	sessionId?: string;
	updatedAt: string;
}

/** Write the sidecar record atomically with mode 0600 inside a 0700 parent directory. */
export function writeHostedAgentState(filePath: string, state: HostedAgentState): void {
	mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
	const nonce = randomBytes(4).toString("hex");
	const temporary = `${filePath}.${process.pid}.${nonce}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
	chmodSync(temporary, 0o600);
	renameSync(temporary, filePath);
}

/** Read and validate a sidecar state file, returning undefined when missing or invalid. */
export function readHostedAgentState(filePath: string): HostedAgentState | undefined {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	let parsed: BoundaryValue;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isObject(parsed) || parsed === null || Array.isArray(parsed)) return undefined;
	// SAFETY: the guards above establish parsed is a non-null JSON object record.
	const record = parsed as JsonObject;
	if (record.version !== 1) return undefined;
	if (!isString(record.name)) return undefined;
	if (!isNumber(record.pid) || !Number.isInteger(record.pid) || record.pid <= 0) return undefined;
	if (!isString(record.cwd) || record.cwd.length === 0) return undefined;
	if (!isString(record.updatedAt) || record.updatedAt.length === 0) return undefined;
	let sessionFile: string | undefined;
	if (record.sessionFile !== undefined) {
		if (!isString(record.sessionFile) || !isAbsolute(record.sessionFile)) return undefined;
		sessionFile = record.sessionFile;
	}
	let sessionId: string | undefined;
	if (record.sessionId !== undefined) {
		if (!isString(record.sessionId) || record.sessionId.length === 0) return undefined;
		sessionId = record.sessionId;
	}
	return {
		version: 1,
		name: record.name,
		pid: record.pid,
		cwd: record.cwd,
		...(sessionFile ? { sessionFile } : undefined),
		...(sessionId ? { sessionId } : undefined),
		updatedAt: record.updatedAt,
	};
}

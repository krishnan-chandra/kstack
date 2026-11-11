/** Turns and cost for one hosted-agent ask, from the agent's Pi session JSONL.
 *
 * The hosted agent's session file is append-only. `readUsageSince` parses only
 * the bytes appended after a recorded offset, so each ask is charged exactly
 * the assistant messages it produced. Malformed or partial trailing lines are
 * skipped; an unreadable or missing file yields zero usage, never a failure.
 * This module intentionally does not import session-archive: shared modules
 * may not import extension modules.
 */

import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { type BoundaryValue, isNumber, isObject, type JsonObject } from "../validation.ts";

export interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

interface UsageRead {
	usage: UsageSummary;
	/** Byte offset just past the last complete line consumed. */
	nextOffset: number;
}

/** Upper bound on bytes parsed per read; appends beyond it are left for the next call. */
const USAGE_MAX_READ_BYTES = 32 * 1024 * 1024;

export function emptyUsage(): UsageSummary {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function tokenCount(raw: BoundaryValue): number {
	return isNumber(raw) && Number.isFinite(raw) ? raw : 0;
}

function parseLine(line: string, usage: UsageSummary): void {
	let entry: BoundaryValue;
	try {
		entry = JSON.parse(line);
	} catch {
		return;
	}
	if (!isObject(entry) || entry === null) return;
	// SAFETY: the isObject guard above establishes the entry is a record.
	const record = entry as JsonObject;
	if (record.type !== "message") return;
	if (!isObject(record.message) || record.message === null) return;
	// SAFETY: the isObject guard above establishes the message is a record.
	const message = record.message as JsonObject;
	if (message.role !== "assistant") return;
	const usageRecord = isObject(message.usage) && !Array.isArray(message.usage) ? message.usage : undefined;
	// SAFETY: tokenCount validates each field; the assertion only supplies the documented record shape.
	const reported = (usageRecord ?? {}) as JsonObject;
	const cost = isObject(reported.cost) && !Array.isArray(reported.cost) ? reported.cost : undefined;
	usage.input += tokenCount(reported.input);
	usage.output += tokenCount(reported.output);
	usage.cacheRead += tokenCount(reported.cacheRead);
	usage.cacheWrite += tokenCount(reported.cacheWrite);
	usage.cost += tokenCount(cost === undefined ? 0 : cost.total);
	usage.turns += 1;
}

/** Current byte size of a session file, or 0 when it does not exist yet. */
export function usageOffset(file: string): number {
	try {
		return statSync(file).size;
	} catch {
		return 0;
	}
}

export function readUsageSince(file: string, offset: number): UsageRead {
	const usage = emptyUsage();
	let nextOffset = offset;
	let handle: number | undefined;
	try {
		handle = openSync(file, "r");
		const size = fstatSync(handle).size;
		if (offset >= size) return { usage, nextOffset: size };
		const length = Math.min(size - offset, USAGE_MAX_READ_BYTES);
		const buffer = Buffer.alloc(length);
		const read = readSync(handle, buffer, 0, length, offset);
		const text = buffer.toString("utf8", 0, read);
		const lastNewline = text.lastIndexOf("\n");
		if (lastNewline === -1) return { usage, nextOffset: offset };
		const complete = text.slice(0, lastNewline + 1);
		nextOffset = offset + Buffer.byteLength(complete, "utf8");
		for (const line of complete.split("\n")) {
			if (line.trim()) parseLine(line, usage);
		}
	} catch {
		return { usage: emptyUsage(), nextOffset };
	} finally {
		if (handle !== undefined) {
			try {
				closeSync(handle);
			} catch {
				/* already closed */
			}
		}
	}
	return { usage, nextOffset };
}

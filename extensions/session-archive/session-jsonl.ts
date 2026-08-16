/** Strict parsing, search-text extraction, byte offsets, and hashing for Pi v3 session JSONL. */

import { createHash } from "node:crypto";
import { isRecord } from "../shared/narrow.ts";

export class SessionParseError extends Error {
	readonly lineNumber?: number;

	constructor(message: string, lineNumber?: number) {
		super(lineNumber === undefined ? message : `line ${lineNumber}: ${message}`);
		this.name = "SessionParseError";
		this.lineNumber = lineNumber;
	}
}

export const MAX_TEXT_CONTENT_CHARS = 200_000;

export interface ParsedSessionHeader {
	id: string;
	timestamp: string;
	cwd: string;
}

export interface ParsedEntry {
	entryId: string;
	parentId: string | null;
	entryType: string;
	timestamp: string;
	ordinal: number;
	role?: string;
	sessionName?: string;
	sessionNamePresent?: boolean;
	textContent?: string;
	rawOffset: number;
	rawLength: number;
}

export interface ParsedSession {
	header: ParsedSessionHeader;
	entries: ParsedEntry[];
}

function requireString(value: unknown, field: string, line: number): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new SessionParseError(`missing or invalid "${field}"`, line);
	}
	return value;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function extractText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts = content.flatMap((block) =>
		isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [],
	);
	return parts.length > 0 ? parts.join("\n") : undefined;
}

function setText(entry: ParsedEntry, text: string | undefined): void {
	if (text) entry.textContent = text.slice(0, MAX_TEXT_CONTENT_CHARS);
}

function extractEntryText(entry: ParsedEntry, raw: Record<string, unknown>): void {
	if (entry.entryType === "message") {
		const message = raw.message;
		if (!isRecord(message)) return;
		entry.role = optionalString(message.role);
		if (message.role === "bashExecution") {
			const command = optionalString(message.command) ?? "";
			const output = optionalString(message.output);
			setText(entry, output ? `$ ${command}\n${output}` : `$ ${command}`);
			return;
		}
		if (message.role === "branchSummary" || message.role === "compactionSummary") {
			setText(entry, optionalString(message.summary));
			return;
		}
		setText(entry, extractText(message.content));
		return;
	}

	switch (entry.entryType) {
		case "compaction":
		case "branch_summary":
			setText(entry, optionalString(raw.summary));
			break;
		case "custom_message":
			setText(entry, extractText(raw.content));
			break;
		case "label":
			setText(entry, optionalString(raw.label));
			break;
		case "session_info":
			entry.sessionNamePresent = true;
			entry.sessionName = optionalString(raw.name);
			setText(entry, entry.sessionName);
			break;
	}
}

interface JsonlLine {
	text: string;
	lineNumber: number;
	byteOffset: number;
	byteLength: number;
}

function nonblankLines(content: string): JsonlLine[] {
	const physicalLines = content.split("\n");
	const lines: JsonlLine[] = [];
	let byteOffset = 0;
	for (let i = 0; i < physicalLines.length; i++) {
		const text = physicalLines[i];
		const byteLength = Buffer.byteLength(text);
		if (text.trim()) lines.push({ text, lineNumber: i + 1, byteOffset, byteLength });
		byteOffset += byteLength + (i + 1 < physicalLines.length ? 1 : 0);
	}
	return lines;
}

export function parseSessionJsonl(content: string): ParsedSession {
	const lines = nonblankLines(content);
	if (lines.length === 0) throw new SessionParseError("empty session file");

	const headerLine = lines[0];
	let rawHeader: unknown;
	try {
		rawHeader = JSON.parse(headerLine.text);
	} catch {
		throw new SessionParseError("header is not valid JSON (file may be truncated)", headerLine.lineNumber);
	}
	if (!isRecord(rawHeader) || rawHeader.type !== "session") {
		throw new SessionParseError('first line must be a {"type":"session"} header', headerLine.lineNumber);
	}
	if (rawHeader.version !== 3) {
		throw new SessionParseError(
			`unsupported session version: ${String(rawHeader.version)} (expected 3)`,
			headerLine.lineNumber,
		);
	}
	const header: ParsedSessionHeader = {
		id: requireString(rawHeader.id, "id", headerLine.lineNumber),
		timestamp: requireString(rawHeader.timestamp, "timestamp", headerLine.lineNumber),
		cwd: requireString(rawHeader.cwd, "cwd", headerLine.lineNumber),
	};

	const entries: ParsedEntry[] = [];
	const seenIds = new Set<string>();
	for (const line of lines.slice(1)) {
		let raw: unknown;
		try {
			raw = JSON.parse(line.text);
		} catch {
			throw new SessionParseError("invalid JSON (file may be truncated)", line.lineNumber);
		}
		if (!isRecord(raw)) throw new SessionParseError("entry is not a JSON object", line.lineNumber);
		const entryType = requireString(raw.type, "type", line.lineNumber);
		if (entryType === "session") {
			throw new SessionParseError("session header may only appear on the first line", line.lineNumber);
		}
		const entryId = requireString(raw.id, "id", line.lineNumber);
		if (seenIds.has(entryId)) throw new SessionParseError(`duplicate entry id "${entryId}"`, line.lineNumber);
		seenIds.add(entryId);
		if (raw.parentId !== null && typeof raw.parentId !== "string") {
			throw new SessionParseError('"parentId" must be a string or null', line.lineNumber);
		}
		const entry: ParsedEntry = {
			entryId,
			parentId: raw.parentId,
			entryType,
			timestamp: requireString(raw.timestamp, "timestamp", line.lineNumber),
			ordinal: entries.length,
			rawOffset: line.byteOffset,
			rawLength: line.byteLength,
		};
		extractEntryText(entry, raw);
		entries.push(entry);
	}
	return { header, entries };
}

export function parseSessionJsonlBytes(content: Uint8Array): ParsedSession {
	try {
		return parseSessionJsonl(new TextDecoder("utf-8", { fatal: true }).decode(content));
	} catch (error) {
		if (error instanceof SessionParseError) throw error;
		throw new SessionParseError("session file is not valid UTF-8");
	}
}

export function sha256Hex(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

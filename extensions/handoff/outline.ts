/**
 * Deterministic outline of a handoff transcript: a bounded map of the whole
 * session whose ordinal-ranged units can be expanded through the entries view.
 * Tool calls appear only as names and allowlisted targets; successful tool
 * output, thinking, images, and edit/write payloads never appear.
 */

import { clipUtf8, clipUtf8Start, collapseWhitespace } from "./text.ts";
import { type SessionTranscript, type ToolCallSummary, type TranscriptEntry, toolCallsOf } from "./transcript.ts";

export const DEFAULT_OUTLINE_BYTES = 40 * 1024;
const UNIT_MAX_BYTES = 4096;
const HEADER_MAX_BYTES = 4096;
const CONTINUATION_RESERVE_BYTES = 256;
const RECENT_ORDINALS = 40;
const CLIP = {
	user: 300,
	finalUser: 2000,
	assistant: 160,
	recentAssistant: 600,
	finalAssistant: 3000,
	target: 60,
	targetsPerTool: 3,
	recentTargetsPerTool: 8,
	failure: 160,
	summary: 600,
	custom: 160,
	recentCustom: 600,
	toolName: 40,
	toolsPerLine: 6,
	metaKinds: 5,
	headerPaths: 20,
	headerPath: 160,
	headerErrorOrdinals: 8,
	cwd: 512,
} as const;

type LeadKind = "user" | "assistant" | "tools" | "failure" | "compaction" | "summary" | "custom" | "bash";

/** A contiguous ordinal range rendered as one or two lines. */
type Unit =
	| { kind: "meta"; start: number; end: number; metaKinds: Map<string, number> }
	| { kind: LeadKind; start: number; end: number; lead: TranscriptEntry; calls: ToolCallSummary[] };

/** The unit an entry opens, or "extend" when it joins the current unit. */
function roleOf(entry: TranscriptEntry): LeadKind | "extend" {
	if (entry.entryType === "compaction") return "compaction";
	if (entry.entryType === "branch_summary") return "summary";
	if (entry.entryType === "custom_message") return "custom";
	if (entry.entryType !== "message") return "extend";
	switch (entry.role) {
		case "user":
			return "user";
		case "assistant":
			if (entry.textContent?.trim()) return "assistant";
			return toolCallsOf(entry).length > 0 ? "tools" : "extend";
		case "toolResult":
			return entry.detail.kind === "toolResult" && entry.detail.isError ? "failure" : "extend";
		case "bashExecution":
			return "bash";
		case "compactionSummary":
			return "compaction";
		case "branchSummary":
			return "summary";
		default:
			return "extend";
	}
}

function kindLabel(entry: TranscriptEntry): string {
	return entry.role ? `${entry.entryType}/${entry.role}` : entry.entryType;
}

function buildUnits(entries: readonly TranscriptEntry[]): Unit[] {
	const units: Unit[] = [];
	let current: Unit | undefined;
	const open = (kind: LeadKind, lead: TranscriptEntry) => {
		const unit: Unit = { kind, start: lead.ordinal, end: lead.ordinal, lead, calls: [...toolCallsOf(lead)] };
		units.push(unit);
		current = unit;
	};
	for (const entry of entries) {
		const role = roleOf(entry);
		switch (role) {
			case "extend":
				if (current === undefined) {
					current = { kind: "meta", start: entry.ordinal, end: entry.ordinal, metaKinds: new Map() };
					units.push(current);
				}
				current.end = entry.ordinal;
				if (current.kind === "meta") {
					const label = kindLabel(entry);
					current.metaKinds.set(label, (current.metaKinds.get(label) ?? 0) + 1);
				}
				break;
			case "tools":
				// Tool-only messages join the open tool group, including an assistant message's calls.
				if (current?.kind === "tools" || current?.kind === "assistant") {
					current.end = entry.ordinal;
					current.calls.push(...toolCallsOf(entry));
				} else {
					open("tools", entry);
				}
				break;
			default:
				open(role, entry);
		}
	}
	return units;
}

/** Drop a trailing lone high surrogate left by slicing UTF-16 text. */
function headSlice(text: string, length: number): string {
	if (text.length <= length) return text;
	const code = text.charCodeAt(length - 1);
	return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}

/** Whitespace-collapsed excerpt bounded in bytes; work is bounded by `maxBytes`. */
function excerpt(text: string | undefined, maxBytes: number): string {
	if (!text) return "";
	return clipUtf8(collapseWhitespace(headSlice(text, maxBytes * 2)), maxBytes);
}

/** Excerpt that keeps line structure, indented under its unit. */
function blockExcerpt(text: string | undefined, maxBytes: number): string {
	if (!text) return "";
	const lines = headSlice(text, maxBytes * 2)
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim());
	return clipUtf8(lines.join("\n    "), maxBytes);
}

/** Paths keep their informative tail; other targets keep their head. */
function targetExcerpt(target: string, maxBytes: number): string {
	if (target.includes("/") && !/\s/u.test(target)) return clipUtf8Start(target, maxBytes);
	return excerpt(target, maxBytes);
}

/** The first non-blank line, found without splitting the whole (possibly 200,000-character) text. */
function firstLine(text: string | undefined): string {
	const trimmed = (text ?? "").trimStart();
	const newline = trimmed.indexOf("\n");
	return (newline === -1 ? trimmed : trimmed.slice(0, newline)).trim();
}

/** Display form of a target: cwd-relative paths, and commands without a leading `cd <dir> &&`. */
function displayTarget(target: string, cwd: string): string {
	const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
	if (target.startsWith(prefix)) return target.slice(prefix.length);
	return target.replace(/^cd \S+ *(?:&&|;) */u, "");
}

function toolLine(calls: readonly ToolCallSummary[], recent: boolean, cwd: string): string {
	const groups = new Map<string, { count: number; targets: Set<string> }>();
	for (const call of calls) {
		let group = groups.get(call.name);
		if (!group) {
			group = { count: 0, targets: new Set() };
			groups.set(call.name, group);
		}
		group.count++;
		if (call.target) {
			// Re-insert so the most recent distinct targets are shown.
			group.targets.delete(call.target);
			group.targets.add(call.target);
		}
	}
	const sorted = [...groups].sort((left, right) => right[1].count - left[1].count);
	const maxTargets = recent ? CLIP.recentTargetsPerTool : CLIP.targetsPerTool;
	const parts = sorted.slice(0, CLIP.toolsPerLine).map(([name, group]) => {
		const targets = [...group.targets].slice(-maxTargets);
		const shown = targets.map((target) => targetExcerpt(displayTarget(target, cwd), CLIP.target));
		const hidden = group.targets.size - targets.length;
		if (hidden > 0) shown.push(`+${hidden}`);
		const count = group.count > 1 ? ` ×${group.count}` : "";
		const list = shown.length > 0 ? ` (${shown.join(", ")})` : "";
		return `${excerpt(name, CLIP.toolName)}${count}${list}`;
	});
	const rest = sorted.slice(CLIP.toolsPerLine);
	if (rest.length > 0) {
		const restCalls = rest.reduce((sum, [, group]) => sum + group.count, 0);
		parts.push(`+${rest.length} other tools (${restCalls} calls)`);
	}
	return parts.join(" · ");
}

interface SessionMarks {
	total: number;
	finalUserOrdinal: number;
	finalAssistantOrdinal: number;
	cwd: string;
}

function metaSummary(unit: Extract<Unit, { kind: "meta" }>): string {
	const kinds = [...unit.metaKinds].sort((left, right) => right[1] - left[1]);
	const shown = kinds.slice(0, CLIP.metaKinds).map(([kind, count]) => `${excerpt(kind, CLIP.toolName)} ×${count}`);
	if (kinds.length > CLIP.metaKinds) shown.push(`+${kinds.length - CLIP.metaKinds} kinds`);
	const count = unit.end - unit.start + 1;
	return `${count} ${count === 1 ? "entry" : "entries"} (${shown.join(", ")})`;
}

function unitBody(unit: Unit, marks: SessionMarks): string {
	if (unit.kind === "meta") return `META: ${metaSummary(unit)}`;
	const { lead } = unit;
	const recent = unit.end >= marks.total - RECENT_ORDINALS;
	switch (unit.kind) {
		case "user": {
			const text =
				lead.ordinal === marks.finalUserOrdinal
					? blockExcerpt(lead.textContent, CLIP.finalUser)
					: excerpt(lead.textContent, CLIP.user);
			return `USER: ${text || "(no text)"}`;
		}
		case "assistant": {
			let text: string;
			if (lead.ordinal === marks.finalAssistantOrdinal) text = blockExcerpt(lead.textContent, CLIP.finalAssistant);
			else text = excerpt(lead.textContent, recent ? CLIP.recentAssistant : CLIP.assistant);
			const calls = unit.calls.length > 0 ? `\n  → ${toolLine(unit.calls, recent, marks.cwd)}` : "";
			return `ASSISTANT: ${text}${calls}`;
		}
		case "tools":
			return `→ ${toolLine(unit.calls, recent, marks.cwd)}`;
		case "failure": {
			const toolName = lead.detail.kind === "toolResult" ? lead.detail.toolName : "tool";
			const error = excerpt(firstLine(lead.textContent), CLIP.failure) || "(no error text)";
			return `✗ ${excerpt(toolName, CLIP.toolName)}: ${error}`;
		}
		case "compaction":
			return `COMPACTION: ${excerpt(lead.textContent, CLIP.summary)}`;
		case "summary":
			return `SUMMARY: ${excerpt(lead.textContent, CLIP.summary)}`;
		case "custom": {
			const customType = lead.detail.kind === "custom" ? lead.detail.customType : "custom";
			const text = excerpt(lead.textContent, recent ? CLIP.recentCustom : CLIP.custom);
			return `CUSTOM ${excerpt(customType, CLIP.toolName)}: ${text}`;
		}
		case "bash":
			return `BASH: ${excerpt(firstLine(lead.textContent), CLIP.custom)}`;
		default: {
			const exhaustive: never = unit;
			throw new Error(`unhandled outline unit ${JSON.stringify(exhaustive)}`);
		}
	}
}

function formatOrdinalRange(start: number, end: number): string {
	return start === end ? `#${start}` : `#${start}–${end}`;
}

function renderUnit(unit: Unit, marks: SessionMarks): string {
	const text = `${formatOrdinalRange(unit.start, unit.end)} ${unitBody(unit, marks)}`;
	return clipUtf8(text, UNIT_MAX_BYTES, `…[unit clipped; expand with view: "entries", offset: ${unit.start}]`);
}

interface HeaderStats {
	editTargets: Map<string, { ok: number; failed: number; unknown: number }>;
	errorOrdinals: number[];
	pending: number;
}

/** Correlate calls and results by toolCallId; the first result for an ID wins. */
function correlate(entries: readonly TranscriptEntry[]): Map<string, boolean> {
	const outcomes = new Map<string, boolean>();
	for (const entry of entries) {
		if (entry.detail.kind !== "toolResult" || !entry.detail.toolCallId) continue;
		if (!outcomes.has(entry.detail.toolCallId)) outcomes.set(entry.detail.toolCallId, entry.detail.isError);
	}
	return outcomes;
}

function headerStats(transcript: SessionTranscript, included: readonly TranscriptEntry[]): HeaderStats {
	const outcomes = correlate(transcript.entries);
	const callIds = new Set<string>();
	for (const entry of transcript.entries) for (const call of toolCallsOf(entry)) if (call.id) callIds.add(call.id);
	const stats: HeaderStats = { editTargets: new Map(), errorOrdinals: [], pending: 0 };
	const seenResults = new Set<string>();
	for (const entry of included) {
		if (entry.detail.kind === "toolResult") {
			const { toolCallId, isError } = entry.detail;
			// `included` is a prefix of the transcript, so the first result seen here is the first overall.
			// Orphan results and later duplicates are ignored for counts.
			if (!seenResults.has(toolCallId) && isError && callIds.has(toolCallId)) stats.errorOrdinals.push(entry.ordinal);
			seenResults.add(toolCallId);
			continue;
		}
		for (const call of toolCallsOf(entry)) {
			const outcome = call.id ? outcomes.get(call.id) : undefined;
			if (outcome === undefined) stats.pending++;
			if ((call.name !== "edit" && call.name !== "write") || !call.target) continue;
			const path = displayTarget(call.target, transcript.cwd);
			const counts = stats.editTargets.get(path) ?? { ok: 0, failed: 0, unknown: 0 };
			if (outcome === undefined) counts.unknown++;
			else if (outcome) counts.failed++;
			else counts.ok++;
			stats.editTargets.set(path, counts);
		}
	}
	return stats;
}

function editTargetsLine(stats: HeaderStats, shownPaths: number): string {
	const label = "Edit/write targets (✓ succeeded, ✗ failed, ? no result; shell-driven changes are not tracked):";
	if (stats.editTargets.size === 0) return `${label} none`;
	const sorted = [...stats.editTargets].sort(
		(left, right) => right[1].ok + right[1].failed + right[1].unknown - (left[1].ok + left[1].failed + left[1].unknown),
	);
	const parts = sorted.slice(0, shownPaths).map(([path, counts]) => {
		const marks = [
			counts.ok > 0 ? `✓${counts.ok}` : "",
			counts.failed > 0 ? `✗${counts.failed}` : "",
			counts.unknown > 0 ? `?${counts.unknown}` : "",
		].filter(Boolean);
		return `${targetExcerpt(path, CLIP.headerPath)} ${marks.join(" ")}`;
	});
	if (sorted.length > shownPaths) parts.push(`+${sorted.length - shownPaths} more`);
	return `${label} ${parts.join(", ")}`;
}

function renderHeader(
	transcript: SessionTranscript,
	included: readonly TranscriptEntry[],
	before: number | undefined,
): string {
	const stats = headerStats(transcript, included);
	const total = transcript.entries.length;
	const first = included[0];
	const last = included.at(-1);
	const scope = before === undefined ? "" : ` (entries before #${before})`;
	const range =
		first && last
			? `Outline of ${formatOrdinalRange(first.ordinal, last.ordinal)}${scope}, ${first.timestamp} → ${last.timestamp}`
			: `Outline: no entries${scope}`;
	const errors = stats.errorOrdinals.slice(-CLIP.headerErrorOrdinals).map((ordinal) => `#${ordinal}`);
	const fixed = [
		`Previous session ${transcript.sessionId} — ${clipUtf8Start(transcript.cwd, CLIP.cwd)} — source: ${transcript.sourceKind} — ${total} entries`,
		range,
	];
	const tail = [
		`Tool errors: ${stats.errorOrdinals.length}${errors.length > 0 ? ` (last: ${errors.join(", ")})` : ""}`,
		`Pending or unknown calls: ${stats.pending}`,
		'Expand entries with read_handoff_history({ view: "entries", offset: <#>, limit: <n> }); find text with search_handoff_history({ query }).',
	];
	// Only the variable-length path list shrinks, so the range and guidance always survive.
	for (let shown = Math.min(CLIP.headerPaths, stats.editTargets.size); shown >= 0; shown--) {
		const header = [...fixed, editTargetsLine(stats, shown), ...tail].join("\n");
		if (Buffer.byteLength(header) <= HEADER_MAX_BYTES) return header;
	}
	return clipUtf8([...fixed, ...tail].join("\n"), HEADER_MAX_BYTES);
}

function sessionMarks(transcript: SessionTranscript): SessionMarks {
	let finalUserOrdinal = -1;
	let finalAssistantOrdinal = -1;
	for (const entry of transcript.entries) {
		const role = roleOf(entry);
		if (role === "user") finalUserOrdinal = entry.ordinal;
		else if (role === "assistant") finalAssistantOrdinal = entry.ordinal;
	}
	return { total: transcript.entries.length, finalUserOrdinal, finalAssistantOrdinal, cwd: transcript.cwd };
}

/** Render the outline of entries before `before` (or all entries) within `budgetBytes` UTF-8 bytes. */
export function renderOutline(
	transcript: SessionTranscript,
	options: { before?: number; budgetBytes?: number } = {},
): string {
	const budgetBytes = options.budgetBytes ?? DEFAULT_OUTLINE_BYTES;
	const before = options.before;
	const included =
		before === undefined ? transcript.entries : transcript.entries.filter((entry) => entry.ordinal < before);
	const header = renderHeader(transcript, included, before);
	if (included.length === 0) return `${header}\n\nNo entries.`;

	const units = buildUnits(included);
	const marks = sessionMarks(transcript);
	const bodyBudget = budgetBytes - Buffer.byteLength(header) - 2 - CONTINUATION_RESERVE_BYTES;
	const rendered: string[] = [];
	let used = 0;
	let oldest = units.length;
	// Fill from the newest unit backward; at least one unit always fits.
	for (let index = units.length - 1; index >= 0; index--) {
		const text = renderUnit(units[index], marks);
		const size = Buffer.byteLength(text) + 1;
		if (used + size > bodyBudget && rendered.length > 0) break;
		rendered.push(text);
		used += size;
		oldest = index;
	}
	rendered.reverse();
	const firstShown = units[oldest].start;
	if (firstShown > 0) {
		rendered.unshift(
			`Entries ${formatOrdinalRange(0, firstShown - 1)} are not outlined; call read_handoff_history({ before: ${firstShown} }).`,
		);
	}
	return `${header}\n\n${rendered.join("\n")}`;
}

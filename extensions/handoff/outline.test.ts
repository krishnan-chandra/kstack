import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_OUTLINE_BYTES, renderOutline } from "./outline.ts";
import type { SessionTranscript, ToolCallSummary, TranscriptDetail, TranscriptEntry } from "./transcript.ts";

type EntryInput = Partial<Omit<TranscriptEntry, "ordinal">> & { entryType: string; detail?: TranscriptDetail };

const CWD = "/work/project";
const UNIT_LINE = /^#(\d+)(?:–(\d+))? (?=[A-Z]+\b|→|✗)/u;

function transcript(inputs: EntryInput[]): SessionTranscript {
	const entries = inputs.map((input, ordinal): TranscriptEntry => {
		const { detail, ...rest } = input;
		return {
			entryId: `e${ordinal}`,
			parentId: ordinal === 0 ? null : `e${ordinal - 1}`,
			timestamp: `2026-09-24T00:00:${String(ordinal % 60).padStart(2, "0")}.000Z`,
			rawOffset: 0,
			rawLength: 0,
			...rest,
			ordinal,
			detail: detail ?? { kind: "none" },
		};
	});
	return { kind: "transcript", sourceKind: "active", sessionId: "s-1", cwd: CWD, entries };
}

const user = (text: string): EntryInput => ({ entryType: "message", role: "user", textContent: text });
const assistant = (text: string, toolCalls: ToolCallSummary[] = []): EntryInput => ({
	entryType: "message",
	role: "assistant",
	textContent: text || undefined,
	detail: { kind: "assistant", toolCalls },
});
const call = (id: string, name: string, target?: string): ToolCallSummary => ({ id, name, target });
const result = (toolCallId: string, toolName: string, text: string, isError = false): EntryInput => ({
	entryType: "message",
	role: "toolResult",
	textContent: text,
	detail: { kind: "toolResult", toolCallId, toolName, isError },
});
const meta = (entryType: string): EntryInput => ({ entryType });

/** Parse unit ranges from rendered outline lines. */
function unitRanges(output: string): [number, number][] {
	const ranges: [number, number][] = [];
	for (const line of output.split("\n")) {
		const match = UNIT_LINE.exec(line);
		if (match) ranges.push([Number(match[1]), Number(match[2] ?? match[1])]);
	}
	return ranges;
}

function unitTexts(output: string): string[] {
	const units: string[] = [];
	for (const line of output.split("\n")) {
		if (UNIT_LINE.test(line)) units.push(line);
		else if (units.length > 0 && line.startsWith("  ")) units[units.length - 1] += `\n${line}`;
	}
	return units;
}

function assertContiguous(ranges: [number, number][], first: number, last: number): void {
	assert.ok(ranges.length > 0);
	assert.equal(ranges[0][0], first);
	assert.equal(ranges.at(-1)?.[1], last);
	for (let i = 0; i < ranges.length; i++) {
		assert.ok(ranges[i][0] <= ranges[i][1]);
		if (i > 0) assert.equal(ranges[i][0], ranges[i - 1][1] + 1);
	}
}

/** Follow `before` continuations and return every rendered range plus each response. */
function followContinuations(input: SessionTranscript, budgetBytes = DEFAULT_OUTLINE_BYTES) {
	const responses: string[] = [];
	const covered: number[] = [];
	let before: number | undefined;
	for (let guard = 0; guard < 10_000; guard++) {
		const output = renderOutline(input, { before, budgetBytes });
		responses.push(output);
		const ranges = unitRanges(output);
		for (const [start, end] of ranges) for (let n = start; n <= end; n++) covered.push(n);
		const next = /read_handoff_history\(\{ before: (\d+) \}\)/u.exec(output);
		if (!next) return { responses, covered };
		const nextBefore = Number(next[1]);
		assert.ok(before === undefined || nextBefore < before, "continuations make progress");
		before = nextBefore;
	}
	throw new Error("continuations did not terminate");
}

function assertBounded(output: string, budget = DEFAULT_OUTLINE_BYTES): void {
	assert.ok(Buffer.byteLength(output) <= budget, `response is ${Buffer.byteLength(output)} bytes`);
	for (const unit of unitTexts(output))
		assert.ok(Buffer.byteLength(unit) <= 4096, `unit is ${Buffer.byteLength(unit)}`);
	const header = output.split("\n\n")[0];
	assert.ok(Buffer.byteLength(header) <= 4096);
	assert.ok(!output.includes("\uFFFD"));
}

describe("renderOutline", () => {
	it("maps every entry kind to contiguous, disjoint units", () => {
		const input = transcript([
			meta("model_change"),
			meta("thinking_level_change"),
			result("orphan", "read", "leading successful output body"),
			user("please fix the reader"),
			assistant("Looking first.", [call("c1", "read", `${CWD}/src/reader.ts`)]),
			result("c1", "read", "SUCCESSFUL-BODY-SECRET"),
			assistant("", [call("c2", "bash", "cd /work/project && npm test")]),
			result("c2", "bash", "Error: 3 tests failed\nstack line", true),
			assistant("", [call("c3", "edit", `${CWD}/src/reader.ts`)]),
			result("c3", "edit", "ok"),
			{ entryType: "compaction", textContent: "compacted earlier work" },
			{ entryType: "custom_message", textContent: "panel findings", detail: { kind: "custom", customType: "panel" } },
			{ entryType: "message", role: "bashExecution", textContent: "$ git status\nclean" },
			meta("label"),
			{ entryType: "branch_summary", textContent: "explored another branch" },
			assistant("Done: fixed the reader."),
			result("c9", "read", "trailing orphan result"),
		]);

		const output = renderOutline(input);

		assertContiguous(unitRanges(output), 0, 16);
		assert.match(
			output,
			/^#0–2 META: 3 entries \(model_change ×1, thinking_level_change ×1, message\/toolResult ×1\)$/mu,
		);
		assert.match(output, /^#3 USER: please fix the reader$/mu);
		assert.match(output, /^#4–6 ASSISTANT: Looking first\.\n {2}→ read \(src\/reader\.ts\) · bash \(npm test\)$/mu);
		assert.match(output, /^#7 ✗ bash: Error: 3 tests failed$/mu);
		assert.match(output, /^#8–9 → edit \(src\/reader\.ts\)$/mu);
		assert.match(output, /^#10 COMPACTION: compacted earlier work$/mu);
		assert.match(output, /^#11 CUSTOM panel: panel findings$/mu);
		assert.match(output, /^#12–13 BASH: \$ git status$/mu);
		assert.match(output, /^#14 SUMMARY: explored another branch$/mu);
		assert.match(output, /^#15–16 ASSISTANT: Done: fixed the reader\.$/mu);
		assert.ok(!output.includes("SUCCESSFUL-BODY-SECRET"));
		assert.ok(!output.includes("stack line"));
		assert.ok(!output.includes("leading successful output body"));
		assertBounded(output);
	});

	it("reports edit targets with correlated outcomes, tool errors, and pending calls", () => {
		const input = transcript([
			user("go"),
			assistant("", [
				call("e1", "edit", `${CWD}/a.ts`),
				call("e2", "edit", `${CWD}/a.ts`),
				call("w1", "write", "/elsewhere/b.md"),
				call("e3", "edit", `${CWD}/c.ts`),
				call("dup", "read", "d.ts"),
			]),
			result("e1", "edit", "ok"),
			result("e2", "edit", "Found 2 occurrences", true),
			result("w1", "write", "ok"),
			result("dup", "read", "first result wins", true),
			result("dup", "read", "later duplicate is ignored"),
			result("ghost", "bash", "orphan failure is ignored for counts", true),
		]);

		const output = renderOutline(input);

		assert.match(
			output,
			/Edit\/write targets \([^)]*shell-driven changes are not tracked\): a\.ts ✓1 ✗1, \/elsewhere\/b\.md ✓1, c\.ts \?1$/mu,
		);
		assert.match(output, /^Tool errors: 2 \(last: #3, #5\)$/mu);
		assert.match(output, /^Pending or unknown calls: 1$/mu);
		assert.match(output, /^#7 ✗ bash: orphan failure is ignored for counts$/mu);
	});

	it("keeps a single user turn with 5,000 tool calls bounded", () => {
		const inputs: EntryInput[] = [user("run everything")];
		for (let i = 0; i < 5000; i++) {
			inputs.push(assistant("", [call(`c${i}`, i % 2 ? "bash" : "read", `target-${i}`)]));
			inputs.push(result(`c${i}`, i % 2 ? "bash" : "read", "x".repeat(100)));
		}
		const input = transcript(inputs);

		const output = renderOutline(input);

		assertBounded(output);
		assertContiguous(unitRanges(output), 0, 10_000);
		// The group ends within the last 40 ordinals, so it shows 8 recent targets per tool.
		assert.match(output, /^#1–10000 → read ×2500 \(target-4984, [^)]*, target-4998, \+2492\) · bash ×2500/mu);
	});

	it("caps 300 distinct long tool names in one message and across one group", () => {
		const longName = (i: number) => `tool_${i}_${"n".repeat(80)}`;
		const oneMessage = transcript([
			user("go"),
			assistant(
				"",
				Array.from({ length: 300 }, (_, i) => call(`c${i}`, longName(i), `${"t".repeat(100)}-${i}`)),
			),
		]);
		const group = transcript([
			user("go"),
			...Array.from({ length: 300 }, (_, i) => assistant("", [call(`c${i}`, longName(i), `target-${i}`)])),
		]);
		for (const input of [oneMessage, group]) {
			const output = renderOutline(input);
			assertBounded(output);
			assert.match(output, /\+294 other tools \(294 calls\)/u);
			assertContiguous(unitRanges(output), 0, input.entries.length - 1);
		}
	});

	it("hard-clips an oversized unit with a marker naming its expansion offset", () => {
		const targets = (name: string) =>
			Array.from({ length: 12 }, (_, i) => call(`${name}${i}`, name, `${"p".repeat(90)}${i}`));
		const input = transcript([
			user("go"),
			assistant("final summary ".repeat(400), [
				...targets(`a${"a".repeat(50)}`),
				...targets(`b${"b".repeat(50)}`),
				...targets(`c${"c".repeat(50)}`),
				...targets(`d${"d".repeat(50)}`),
				...targets(`e${"e".repeat(50)}`),
				...targets(`f${"f".repeat(50)}`),
			]),
		]);

		const output = renderOutline(input);

		assertBounded(output);
		const unit = unitTexts(output).at(-1) ?? "";
		assert.equal(Buffer.byteLength(unit) <= 4096, true);
		assert.ok(unit.endsWith('…[unit clipped; expand with view: "entries", offset: 1]'));
	});

	it("bounds the header with 500 edited paths", () => {
		const input = transcript([
			user("edit everything"),
			assistant(
				"",
				Array.from({ length: 500 }, (_, i) => call(`e${i}`, "edit", `${CWD}/src/${"deep/".repeat(20)}file-${i}.ts`)),
			),
			...Array.from({ length: 500 }, (_, i) => result(`e${i}`, "edit", "ok")),
		]);

		const output = renderOutline(input);

		assertBounded(output);
		const header = output.split("\n\n")[0];
		assert.match(header, /\+\d+ more$/mu);
		assert.match(header, /^Expand entries with read_handoff_history/mu);
		assert.match(header, /^Outline of #0–501/mu);
		assertContiguous(unitRanges(output), 0, 501);
	});

	it("clips multibyte text on code-point boundaries", () => {
		const input = transcript([user("é".repeat(400)), assistant("🙂".repeat(400)), user("final"), assistant("done")]);

		const output = renderOutline(input);

		assertBounded(output);
		const [userUnit, assistantUnit] = unitTexts(output);
		assert.ok(Buffer.byteLength(userUnit) <= "#0 USER: ".length + 300);
		assert.ok(userUnit.endsWith("é…"));
		assert.ok(assistantUnit.endsWith("🙂…"));
	});

	it("renders empty history", () => {
		const output = renderOutline(transcript([]));
		assert.match(output, /Outline: no entries/u);
		assert.ok(output.endsWith("\n\nNo entries."));
	});

	it("follows before continuations to cover every ordinal exactly once", () => {
		const inputs: EntryInput[] = [];
		for (let i = 0; i < 3000; i++) inputs.push(i % 3 === 0 ? meta("label") : user(`request ${i} ${"w".repeat(400)}`));
		const input = transcript(inputs);

		const { responses, covered } = followContinuations(input);

		assert.ok(responses.length > 5);
		for (const response of responses) assertBounded(response);
		assert.deepEqual(
			[...covered].sort((a, b) => a - b),
			Array.from({ length: 3000 }, (_, i) => i),
		);
		assert.equal(new Set(covered).size, covered.length);
		assert.match(responses[1], /^Outline of #0–\d+ \(entries before #\d+\)/mu);
	});

	it("still makes progress with a small budget", () => {
		const input = transcript(Array.from({ length: 50 }, (_, i) => user(`u${i} ${"z".repeat(290)}`)));

		const { responses, covered } = followContinuations(input, 6000);

		for (const response of responses) assertBounded(response, 6000);
		assert.deepEqual(
			[...covered].sort((a, b) => a - b),
			Array.from({ length: 50 }, (_, i) => i),
		);
	});

	it("gives the final user and assistant messages larger budgets and keeps their lines", () => {
		const input = transcript([
			user(`early ${"a".repeat(1000)}`),
			assistant(`early answer ${"b".repeat(1000)}`),
			user(`final request\nsecond line ${"c".repeat(1000)}`),
			assistant(`final answer\n- item ${"d".repeat(2000)}`),
		]);

		const [earlyUser, earlyAssistant, finalUser, finalAssistant] = unitTexts(renderOutline(input));

		assert.ok(Buffer.byteLength(earlyUser) < 400);
		assert.ok(Buffer.byteLength(earlyAssistant) < 700);
		assert.match(finalUser, /^#2 USER: final request\n {4}second line c+/u);
		assert.ok(Buffer.byteLength(finalUser) > 1000);
		assert.match(finalAssistant, /^#3 ASSISTANT: final answer\n {4}- item d+/u);
		assert.ok(Buffer.byteLength(finalAssistant) > 2000);
	});
});

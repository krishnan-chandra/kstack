import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	availableHistoryTools,
	describeHistoryAccess,
	type HistoryAccess,
	selectHistoryAccess,
} from "./history-access.ts";

const PATH = "/archive/sessions/2026/09/id/session.jsonl";

function select(tools: string[]): HistoryAccess {
	return selectHistoryAccess(new Set(tools), PATH);
}

function promptText(tools: string[]): string {
	const { steps, lookup } = describeHistoryAccess(select(tools));
	return [...steps, lookup].join("\n");
}

describe("selectHistoryAccess", () => {
	const matrix: [string, string[], HistoryAccess][] = [
		["both handoff tools", ["read_handoff_history", "search_handoff_history"], { kind: "handoff", search: true }],
		["the reader only, without built-ins", ["read_handoff_history"], { kind: "handoff", search: false }],
		["the reader beside file tools", ["read_handoff_history", "read", "grep"], { kind: "handoff", search: false }],
		["search only", ["search_handoff_history"], { kind: "handoff-search" }],
		[
			"read and grep",
			["read", "grep", "find", "ls"],
			{ kind: "file", transcriptPath: PATH, reader: "read", searcher: "grep" },
		],
		["read and bash", ["read", "bash"], { kind: "file", transcriptPath: PATH, reader: "read", searcher: "bash" }],
		["bash only", ["bash"], { kind: "file", transcriptPath: PATH, reader: "bash", searcher: "bash" }],
		["read only", ["read"], { kind: "file", transcriptPath: PATH, reader: "read", searcher: undefined }],
		["neither history nor file access", ["find", "ls", "edit"], { kind: "unavailable" }],
		["no tools", [], { kind: "unavailable" }],
	];
	for (const [name, tools, expected] of matrix) {
		it(`selects ${expected.kind} access for ${name}`, () => {
			assert.deepEqual(select(tools), expected);
		});
	}
});

describe("availableHistoryTools", () => {
	it("counts registered handoff tools and active built-ins only", () => {
		const tools = availableHistoryTools({
			getAllTools: () => ["read", "grep", "read_handoff_history", "search_handoff_history"].map((name) => ({ name })),
			getActiveTools: () => ["read"],
		});
		assert.deepEqual([...tools].sort(), ["read", "read_handoff_history", "search_handoff_history"]);
	});
});

describe("describeHistoryAccess", () => {
	it("mentions only the tools each access mode has", () => {
		const full = describeHistoryAccess(select(["read_handoff_history", "search_handoff_history"])).steps;
		assert.equal(full.length, 3);
		assert.match(full[2], /^Use search_handoff_history/u);

		const readerOnly = promptText(["read_handoff_history"]);
		assert.ok(!readerOnly.includes("search_handoff_history"));
		assert.match(readerOnly, /^Call read_handoff_history first/u);

		const searchOnly = promptText(["search_handoff_history"]);
		assert.ok(!searchOnly.includes("read_handoff_history"));
		assert.match(searchOnly, /Only search_handoff_history is available/u);

		const grep = promptText(["read", "grep"]);
		assert.match(grep, /Search it with grep .* read only those line ranges with read/u);
		assert.ok(grep.endsWith(`read the transcript JSONL at ${PATH} with read and grep.`));
		assert.ok(!grep.includes("bash"));

		const bash = promptText(["bash"]);
		assert.match(bash, /Search it with bash \(for example `rg -n`\) .* print only those lines/u);
		assert.ok(bash.endsWith("with bash."));
		assert.ok(!bash.includes("grep"));

		const readOnly = promptText(["read"]);
		assert.match(readOnly, /Read it in bounded ranges with read's offset and limit/u);
		assert.ok(!readOnly.includes("grep"));
		assert.ok(!readOnly.includes("bash"));
	});

	it("warns for every degraded mode and refuses unusable access", () => {
		const notice = (tools: string[]) => describeHistoryAccess(select(tools)).notice;
		assert.equal(notice(["read_handoff_history", "search_handoff_history"]), undefined);
		for (const tools of [["read_handoff_history"], ["search_handoff_history"], ["read"]]) {
			assert.equal(notice(tools)?.level, "warning", tools.join(","));
		}
		assert.equal(notice(["ls"])?.level, "error");
	});

	it("names the archived location only when the replacement reads the file", () => {
		const storage = (tools: string[]) => describeHistoryAccess(select(tools)).archivedStorage;
		assert.match(storage(["read"]), /the Lookup path is its archived location\.$/u);
		assert.match(storage(["read_handoff_history"]), /use the archive fallback by exact session ID\.$/u);
	});
});

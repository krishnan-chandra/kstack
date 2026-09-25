import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	messageEntry,
	sessionJsonl,
	TEST_SESSION_ID,
	toolCallMessage,
	toolResultMessage,
	userMessage,
} from "../session-archive/test-helpers.ts";
import {
	findHandoffSource,
	type HandoffSource,
	preflightHandoffHistory,
	readHandoffHistory,
} from "./history-reader.ts";
import { archiveAndRemoveActive, archiveOversized, useHandoffFixtures } from "./test-helpers.ts";
import { type HandoffHistoryFs, loadHandoffTranscript } from "./transcript.ts";

const fixture = useHandoffFixtures();

describe("findHandoffSource", () => {
	it("prefers structured details from the latest handoff entry", () => {
		const source: HandoffSource = {
			version: 1,
			sessionFile: "/sessions/latest.jsonl",
			sessionId: TEST_SESSION_ID,
			cwd: "/project",
		};
		const found = findHandoffSource([
			{
				type: "custom_message",
				customType: "handoff",
				details: {
					version: 1,
					sessionFile: "/sessions/old.jsonl",
					sessionId: TEST_SESSION_ID,
					cwd: "/project",
				},
			},
			{
				type: "custom_message",
				customType: "handoff",
				details: {
					version: 1,
					sessionFile: source.sessionFile,
					sessionId: source.sessionId,
					cwd: source.cwd,
				},
			},
		]);
		assert.deepEqual(found, source);
	});

	it("constructs HandoffSource without copying extra details fields", () => {
		const details = {
			version: 1,
			sessionFile: "/sessions/latest.jsonl",
			sessionId: TEST_SESSION_ID,
			cwd: "/project",
			extra: "drop-me",
		};
		const found = findHandoffSource([{ type: "custom_message", customType: "handoff", details }]);
		assert.deepEqual(found, {
			version: 1,
			sessionFile: "/sessions/latest.jsonl",
			sessionId: TEST_SESSION_ID,
			cwd: "/project",
		});
		assert.equal(found && "extra" in found, false);
	});

	it("skips malformed details and uses an older valid handoff entry", () => {
		const found = findHandoffSource([
			{
				type: "custom_message",
				customType: "handoff",
				details: {
					version: 1,
					sessionFile: "/sessions/old.jsonl",
					sessionId: TEST_SESSION_ID,
					cwd: "/project",
				},
			},
			{
				type: "custom_message",
				customType: "handoff",
				details: { version: 2, sessionFile: "/sessions/wrong.jsonl" },
			},
		]);
		assert.equal(found?.sessionFile, "/sessions/old.jsonl");
	});

	it("ignores handoff entries that have no structured details", () => {
		assert.equal(
			findHandoffSource([
				{
					type: "custom_message",
					customType: "handoff",
				},
			]),
			undefined,
		);
	});
});

describe("preflightHandoffHistory", () => {
	it("accepts a readable session under Pi's active-session root", () => {
		const { source, env } = fixture();
		assert.deepEqual(preflightHandoffHistory(source, env), { kind: "ready" });
	});

	it("rereads current bytes when cached file metadata is unchanged", () => {
		const { content, source, env } = fixture();
		const cachedStat = statSync(source.sessionFile);
		const fsImpl: HandoffHistoryFs = {
			statSync: () => cachedStat,
			readFileSync,
		};
		loadHandoffTranscript(source, env, fsImpl);
		const replacement = content.replace(TEST_SESSION_ID, "11111111-2222-3333-4444-555555555555");
		assert.equal(Buffer.byteLength(replacement), Buffer.byteLength(content));
		writeFileSync(source.sessionFile, replacement);

		const result = preflightHandoffHistory(source, env, fsImpl);

		assert.equal(result.kind, "rejected");
		if (result.kind === "rejected") assert.match(result.reason, /session ID mismatch/i);
	});

	it("rejects a valid custom session outside Pi's active-session root", () => {
		const { tree, source, env } = fixture();
		const customFile = join(tree.root, "custom.jsonl");
		writeFileSync(customFile, sessionJsonl([], { id: source.sessionId }));

		const result = preflightHandoffHistory({ ...source, sessionFile: customFile }, env);

		assert.equal(result.kind, "rejected");
		if (result.kind === "rejected") assert.match(result.reason, /outside Pi's active session directory/i);
	});

	it("rejects symlinks and directories", () => {
		const { tree, source, env } = fixture();
		const symlink = join(tree.sessionDir, "linked.jsonl");
		const directory = join(tree.sessionDir, "directory.jsonl");
		symlinkSync(source.sessionFile, symlink);
		mkdirSync(directory);

		for (const sessionFile of [symlink, directory]) {
			const result = preflightHandoffHistory({ ...source, sessionFile }, env);
			assert.equal(result.kind, "rejected");
			if (result.kind === "rejected") assert.match(result.reason, /regular non-symlink file/i);
		}
	});

	it("rejects a missing active source even when the exact session is archived", () => {
		const { tree, content, source, env } = fixture();
		archiveAndRemoveActive(tree, content, source);

		const result = preflightHandoffHistory(source, env);

		assert.deepEqual(result, {
			kind: "rejected",
			reason: "The source session no longer exists at its recorded active path.",
		});
	});

	it("rejects malformed JSONL and a mismatched header id", () => {
		for (const content of ["not-json\n", sessionJsonl([], { id: "11111111-2222-3333-4444-555555555555" })]) {
			const { source, env } = fixture();
			writeFileSync(source.sessionFile, content);

			const result = preflightHandoffHistory(source, env);

			assert.equal(result.kind, "rejected");
			if (result.kind === "rejected") assert.match(result.reason, /valid JSON|session ID mismatch/i);
		}
	});

	it("rejects an oversized active source before reading it", () => {
		const { source, env } = fixture();
		truncateSync(source.sessionFile, 64 * 1024 * 1024 + 1);

		const result = preflightHandoffHistory(source, env);

		assert.equal(result.kind, "rejected");
		if (result.kind === "rejected") {
			assert.match(result.reason, /active-reader limit/i);
			assert.match(result.reason, /\/handoff --archive/);
		}
	});

	it("bounds rejection reasons", () => {
		const { source, env } = fixture();
		const result = preflightHandoffHistory({ ...source, sessionId: "x".repeat(10_000) }, env);

		assert.equal(result.kind, "rejected");
		if (result.kind === "rejected") {
			assert.ok(Buffer.byteLength(result.reason) <= 1024);
			assert.ok(result.reason.endsWith("..."));
		}
	});
});

function richToolSession(): string {
	return sessionJsonl([
		{
			type: "model_change",
			id: "m0",
			parentId: null,
			timestamp: "2026-08-11T08:48:03.000Z",
			provider: "p",
			modelId: "m",
		},
		messageEntry("u1", "m0", {
			role: "user",
			content: [
				{ type: "text", text: "fix the history reader" },
				{ type: "image", data: "aGVsbG8tYmFzZTY0LWltYWdlLWRhdGE=", mimeType: "image/png" },
			],
			timestamp: 1,
		}),
		messageEntry(
			"a1",
			"u1",
			toolCallMessage(
				[
					{ id: "c1", name: "read", arguments: { path: "/Users/test/Code/project/src/reader.ts" } },
					{
						id: "c2",
						name: "edit",
						arguments: { path: "src/reader.ts", edits: [{ oldText: "EDIT-OLD-PAYLOAD", newText: "EDIT-NEW-PAYLOAD" }] },
					},
					{ id: "c3", name: "write", arguments: { path: "notes.md", content: "WRITE-PAYLOAD" } },
					{ id: "c4", name: "bash", arguments: { command: "npm test", secret: "NON-ALLOWLISTED-ARG" } },
				],
				"Reading and editing the reader.",
			),
		),
		messageEntry("r1", "a1", toolResultMessage("c1", "read", "SUCCESSFUL-RESULT-BODY")),
		messageEntry("r2", "r1", toolResultMessage("c2", "edit", "ok")),
		messageEntry("r3", "r2", toolResultMessage("c3", "write", "ok")),
		messageEntry("r4", "r3", toolResultMessage("c4", "bash", `${"E".repeat(300)}\nSECOND-ERROR-LINE`, true)),
		messageEntry("a2", "r4", toolCallMessage([], "The reader is fixed; tests remain red.")),
	]);
}

describe("readHandoffHistory", () => {
	it("returns an outline of the whole session by default", () => {
		const { source, env } = fixture(richToolSession());

		const output = readHandoffHistory(source, {}, env);

		assert.match(output, /^Previous session [^\n]+ — source: active — 8 entries$/mu);
		assert.match(output, /^Outline of #0–7, /mu);
		assert.match(output, /^#0 META: 1 entry \(model_change ×1\)$/mu);
		assert.match(output, /^#1 USER: fix the history reader$/mu);
		assert.match(
			output,
			/^#2–5 ASSISTANT: Reading and editing the reader\.\n {2}→ read \(src\/reader\.ts\) · edit \(src\/reader\.ts\) · write \(notes\.md\) · bash \(npm test\)$/mu,
		);
		assert.match(output, /Edit\/write targets \([^)]*\): src\/reader\.ts ✓1, notes\.md ✓1$/mu);
		assert.match(output, /^Tool errors: 1 \(last: #6\)$/mu);
		const failure = output.split("\n").find((line) => line.startsWith("#6 ✗ bash: ")) ?? "";
		assert.ok(Buffer.byteLength(failure.slice("#6 ✗ bash: ".length)) <= 160);
		for (const absent of [
			"secret chain of thought",
			"aGVsbG8tYmFzZTY0",
			"EDIT-OLD-PAYLOAD",
			"EDIT-NEW-PAYLOAD",
			"WRITE-PAYLOAD",
			"NON-ALLOWLISTED-ARG",
			"SUCCESSFUL-RESULT-BODY",
			"SECOND-ERROR-LINE",
		]) {
			assert.ok(!output.includes(absent), absent);
		}
	});

	it("returns the same outline after archival", () => {
		const { tree, content, source, env } = fixture(richToolSession());
		const active = readHandoffHistory(source, {}, env);
		archiveAndRemoveActive(tree, content, source);

		const archived = readHandoffHistory(source, {}, env);

		assert.equal(archived, active.replace("source: active", "source: archived"));
	});

	it("reads normalized recent entries with tool-call summaries in the entries view", () => {
		const { source, env } = fixture();
		const output = readHandoffHistory(source, { view: "entries", limit: 2 }, env);
		assert.ok(output.includes("source: active — view: entries"));
		assert.ok(output.includes("entries 2–3 of 3"));
		assert.ok(output.includes("reference-only handoff\n→ bash ls"));
		assert.ok(output.includes("history reader"));
		assert.ok(!output.includes("secret chain of thought"));
		assert.ok(!output.includes('"command":"ls"'));
		assert.ok(output.includes('Earlier entries are available; use view "entries", offset 0, from=start'));
	});

	it("supports paging from the start and tells the agent to keep the entries view", () => {
		const { source, env } = fixture();
		const output = readHandoffHistory(source, { view: "entries", from: "start", limit: 1 }, env);
		assert.ok(output.includes("entries 1–1 of 3"));
		assert.ok(output.includes("initial architecture discussion"));
		assert.ok(output.includes('continue with offset 1, from=start, and chunk 0 (keep view: "entries")'));
	});

	it("clips tool output to 800 bytes unless full text is requested", () => {
		const big = `${"r".repeat(20_000)}TAIL-MARKER`;
		const huge = "h".repeat(250_000);
		const { source, env } = fixture(
			sessionJsonl([
				messageEntry("a1", null, toolCallMessage([{ id: "c1", name: "read", arguments: { path: "big.txt" } }])),
				messageEntry("r1", "a1", toolResultMessage("c1", "read", big)),
				messageEntry("r2", "r1", toolResultMessage("c1", "read", huge)),
			]),
		);

		const clipped = readHandoffHistory(source, { view: "entries", offset: 1, limit: 1 }, env);
		const full = readHandoffHistory(source, { view: "entries", offset: 1, limit: 1, full: true }, env);
		const capped = readHandoffHistory(source, { view: "entries", offset: 2, limit: 1, full: true, chunk: 4 }, env);

		assert.ok(!clipped.includes("TAIL-MARKER"));
		assert.match(
			clipped,
			/r{800}\n\[\+19211 bytes clipped; read_handoff_history\(\{ view: "entries", offset: 1, limit: 1, full: true \}\)\]/u,
		);
		assert.ok(full.includes(big));
		assert.ok(capped.endsWith("[normalized text capped at 200,000 characters by the session parser]"));
	});

	it("keeps the default outline and entries page small for tool-heavy sessions", () => {
		const entries = [];
		let parent: string | null = null;
		for (let i = 0; i < 100; i++) {
			entries.push(messageEntry(`u${i}`, parent, userMessage(`request ${i}`)));
			entries.push(
				messageEntry(
					`a${i}`,
					`u${i}`,
					toolCallMessage([{ id: `c${i}`, name: "read", arguments: { path: `f${i}.ts` } }]),
				),
			);
			entries.push(messageEntry(`r${i}`, `a${i}`, toolResultMessage(`c${i}`, "read", "x".repeat(20_000))));
			parent = `r${i}`;
		}
		const { source, env } = fixture(sessionJsonl(entries));

		const outline = readHandoffHistory(source, {}, env);
		const page = readHandoffHistory(source, { view: "entries" }, env);

		assert.ok(Buffer.byteLength(outline) <= 16 * 1024, `outline is ${Buffer.byteLength(outline)} bytes`);
		assert.match(page, /entries 251–300 of 300 — chunk 1 of 1 —/u);
	});

	it("falls back to the finalized read-only archive by exact session id", () => {
		const { tree, content, source, env } = fixture();
		archiveAndRemoveActive(tree, content, source);

		const output = readHandoffHistory(source, { view: "entries", limit: 1 }, env);
		assert.ok(output.includes("source: archived"));
		assert.ok(output.includes("history reader"));
	});

	it("uses the bounded entries view for an oversized archive", () => {
		const content = sessionJsonl([
			messageEntry("u1", null, userMessage("oversized request")),
			messageEntry("a1", "u1", toolCallMessage([{ id: "c1", name: "read", arguments: { path: "big.txt" } }])),
			messageEntry("r1", "a1", toolResultMessage("c1", "read", "o".repeat(5000))),
		]);
		const { tree, source, env } = fixture(content);
		archiveOversized(tree, content, source);

		const outline = readHandoffHistory(source, {}, env);
		const entries = readHandoffHistory(source, { view: "entries", from: "start" }, env);

		assert.ok(
			outline.startsWith(
				"Outline unavailable: archived session exceeds the 64 MiB transcript limit; showing the bounded entries view.\n",
			),
		);
		assert.match(outline, /source: archived — view: entries\nentries 1–3 of 3/u);
		assert.ok(entries.startsWith("Previous session"));
		assert.ok(entries.includes("oversized request"));
		assert.match(
			entries,
			/\[\+4200 bytes clipped; read_handoff_history\(\{ view: "entries", offset: 2, limit: 1, full: true \}\)\]/u,
		);
	});

	it("rejects a source whose file header does not match the referenced session id", () => {
		const { source, env } = fixture();
		writeFileSync(source.sessionFile, sessionJsonl([], { id: "11111111-2222-3333-4444-555555555555" }));
		assert.throws(() => readHandoffHistory(source, {}, env), /session ID mismatch/i);
	});

	it("rejects an existing source outside Pi's active session directory", () => {
		const { tree, source, env } = fixture();
		const outside = join(tree.root, "outside.jsonl");
		writeFileSync(outside, sessionJsonl([]));
		assert.throws(
			() => readHandoffHistory({ ...source, sessionFile: outside }, {}, env),
			/outside Pi's active session directory/,
		);
	});
});

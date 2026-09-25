import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
	messageEntry,
	sessionJsonl,
	TEST_SESSION_ID,
	toolCallMessage,
	toolResultMessage,
	userMessage,
} from "../session-archive/test-helpers.ts";
import { archiveAndRemoveActive, archiveOversized, useHandoffFixtures } from "./test-helpers.ts";
import { type HandoffHistoryFs, loadHandoffTranscript } from "./transcript.ts";

const fixture = useHandoffFixtures();

function toolSession(): string {
	return sessionJsonl([
		messageEntry("u1", null, userMessage("fix the reader")),
		messageEntry(
			"a1",
			"u1",
			toolCallMessage(
				[
					{
						id: "c1",
						name: "edit",
						arguments: {
							path: "/Users/test/Code/project/src/reader.ts",
							edits: [
								{ oldText: "OLD-PAYLOAD-SECRET", newText: "NEW-PAYLOAD-SECRET" },
								{ oldText: "a", newText: "b" },
							],
						},
					},
					{ id: "c2", name: "write", arguments: { path: "notes.md", content: "WRITE-PAYLOAD-SECRET" } },
					{ id: "c3", name: "bash", arguments: { command: "npm   test\n  --watch", env: "ENV-ARG-SECRET" } },
					{ id: "c4", name: "custom_tool", arguments: { token: "TOKEN-ARG-SECRET", count: 3 } },
				],
				"Editing now.",
			),
		),
		messageEntry("r1", "a1", toolResultMessage("c1", "edit", "Successfully replaced 2 block(s).")),
		messageEntry("r2", "r1", toolResultMessage("c2", "write", "denied", true)),
		{
			type: "custom_message",
			id: "x1",
			parentId: "r2",
			timestamp: "2026-08-11T08:52:00.000Z",
			customType: "panel-review",
			content: "review findings",
			display: true,
		},
	]);
}

/** One edit call whose result failed, preceded by multibyte text. */
function failedEditSession(): string {
	return sessionJsonl([
		messageEntry("u1", null, userMessage("修正して 🙂 the reader")),
		messageEntry(
			"a1",
			"u1",
			toolCallMessage([{ id: "c1", name: "edit", arguments: { path: "src/日本/reader.ts", edits: [] } }], "Editing."),
		),
		messageEntry("r1", "a1", toolResultMessage("c1", "edit", "Found 2 occurrences", true)),
	]);
}

/** Entry fields the views read; byte offsets legitimately differ between encodings. */
function viewFields(transcript: ReturnType<typeof loadHandoffTranscript>) {
	if (transcript.kind !== "transcript") throw new Error(`expected a parsed transcript, got ${transcript.kind}`);
	return transcript.entries.map(({ entryId, ordinal, role, textContent, detail }) => ({
		entryId,
		ordinal,
		role,
		textContent,
		detail,
	}));
}

describe("transcript encoding parity", () => {
	const plain = failedEditSession();
	const variants: [string, string][] = [
		["BOM-prefixed", `\uFEFF${plain}`],
		["blank-line", plain.replaceAll("\n", "\n\n  \n")],
	];
	for (const [name, content] of variants) {
		it(`keeps the same tool calls, results, and text for ${name} JSONL, active and archived`, () => {
			const reference = fixture(plain);
			const expected = viewFields(loadHandoffTranscript(reference.source, reference.env));
			const { tree, source, env } = fixture(content);
			assert.deepEqual(viewFields(loadHandoffTranscript(source, env)), expected, name);
			archiveAndRemoveActive(tree, content, source);
			assert.deepEqual(viewFields(loadHandoffTranscript(source, env)), expected, name);
		});
	}

	it("reads the failed edit's call and result details", () => {
		const { source, env } = fixture(plain);
		const [, assistant, result] = viewFields(loadHandoffTranscript(source, env));
		assert.deepEqual(assistant.detail, {
			kind: "assistant",
			toolCalls: [{ id: "c1", name: "edit", target: "src/日本/reader.ts", note: "0 edits" }],
		});
		assert.deepEqual(result.detail, { kind: "toolResult", toolCallId: "c1", toolName: "edit", isError: true });
	});
});

describe("loadHandoffTranscript", () => {
	it("loads an active session with tool-call summaries and result correlation fields", () => {
		const { source, env } = fixture(toolSession());

		const transcript = loadHandoffTranscript(source, env);

		assert.equal(transcript.kind, "transcript");
		if (transcript.kind !== "transcript") return;
		assert.equal(transcript.sourceKind, "active");
		assert.equal(transcript.cwd, "/Users/test/Code/project");
		const [, assistant, editResult, writeResult, custom] = transcript.entries;
		assert.deepEqual(assistant.detail, {
			kind: "assistant",
			toolCalls: [
				{ id: "c1", name: "edit", target: "/Users/test/Code/project/src/reader.ts", note: "2 edits" },
				{ id: "c2", name: "write", target: "notes.md", note: "20 bytes" },
				{ id: "c3", name: "bash", target: "npm test --watch" },
				{ id: "c4", name: "custom_tool" },
			],
		});
		assert.deepEqual(editResult.detail, { kind: "toolResult", toolCallId: "c1", toolName: "edit", isError: false });
		assert.deepEqual(writeResult.detail, { kind: "toolResult", toolCallId: "c2", toolName: "write", isError: true });
		assert.deepEqual(custom.detail, { kind: "custom", customType: "panel-review" });
		const serialized = JSON.stringify(transcript.entries.map((entry) => entry.detail));
		for (const secret of ["PAYLOAD-SECRET", "ENV-ARG-SECRET", "TOKEN-ARG-SECRET", "secret chain of thought"]) {
			assert.ok(!serialized.includes(secret), secret);
		}
	});

	it("reuses a parsed session while the file identity is unchanged", () => {
		const { source, env } = fixture();
		let reads = 0;
		const fsImpl: HandoffHistoryFs = {
			statSync,
			readFileSync: /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ ((
				...args: Parameters<typeof readFileSync>
			) => {
				reads++;
				return readFileSync(...args);
			}) as typeof readFileSync,
		};

		loadHandoffTranscript(source, env, fsImpl);
		loadHandoffTranscript(source, env, fsImpl);

		assert.equal(reads, 1);
	});

	it("invalidates the cache when the active session grows", () => {
		const { source, env } = fixture();
		loadHandoffTranscript(source, env);
		appendFileSync(
			source.sessionFile,
			`${JSON.stringify(messageEntry("u3", "u2", userMessage("appended cache entry")))}\n`,
		);

		const transcript = loadHandoffTranscript(source, env);

		assert.equal(transcript.kind === "transcript" && transcript.entries.at(-1)?.textContent, "appended cache entry");
	});

	it("does not serve cached content after the file is replaced with another session id", () => {
		const { source, env } = fixture();
		loadHandoffTranscript(source, env);
		const replacement = `${source.sessionFile}.replacement`;
		writeFileSync(replacement, sessionJsonl([], { id: "11111111-2222-3333-4444-555555555555" }));
		renameSync(replacement, source.sessionFile);

		assert.throws(() => loadHandoffTranscript(source, env), /session ID mismatch/i);
	});

	it("loads the finalized archive artifact with the same entries as the active session", () => {
		const { tree, content, source, env } = fixture(toolSession());
		const active = loadHandoffTranscript(source, env);
		archiveAndRemoveActive(tree, content, source);

		const archived = loadHandoffTranscript(source, env);

		assert.equal(archived.kind, "transcript");
		if (archived.kind !== "transcript" || active.kind !== "transcript") return;
		assert.equal(archived.sourceKind, "archived");
		assert.deepEqual(archived.entries, active.entries);
	});

	it("rejects archived artifacts outside the archive root, symlinked, resized, or with another header id", () => {
		const cases: {
			name: string;
			options: (tree: ReturnType<typeof fixture>["tree"], content: string) => object;
			after?: (archivePath: string, tree: ReturnType<typeof fixture>["tree"], content: string) => void;
			error: RegExp;
		}[] = [
			{
				name: "outside",
				options: (tree) => ({ archivePath: join(tree.root, "elsewhere", "session.jsonl") }),
				error: /outside the archive root/,
			},
			{
				name: "symlink",
				options: () => ({ artifact: null }),
				after: (archivePath, tree, content) => {
					const target = join(tree.archiveRoot, "real.jsonl");
					writeFileSync(target, content);
					mkdirSync(dirname(archivePath), { recursive: true });
					symlinkSync(target, archivePath);
				},
				error: /regular non-symlink file/,
			},
			{
				name: "size",
				options: (_tree, content) => ({ fileSize: Buffer.byteLength(content) + 1 }),
				error: /archive catalog records/,
			},
			{
				name: "header",
				options: (_tree, content) => ({
					artifact: content.replace(TEST_SESSION_ID, "11111111-2222-3333-4444-555555555555"),
				}),
				error: /session ID mismatch/i,
			},
		];
		for (const testCase of cases) {
			const { tree, content, source, env } = fixture();
			const archivePath = archiveAndRemoveActive(tree, content, source, testCase.options(tree, content));
			testCase.after?.(archivePath, tree, content);
			assert.throws(() => loadHandoffTranscript(source, env), testCase.error, testCase.name);
		}
	});

	it("returns an oversized archive after a bounded header check, including after a BOM", () => {
		for (const content of [sessionJsonl([]), `\uFEFF${sessionJsonl([])}`]) {
			const { tree, source, env } = fixture(content);
			archiveOversized(tree, content, source);
			assert.deepEqual(loadHandoffTranscript(source, env), { kind: "oversized-archive" });
		}
	});

	it("rejects an oversized archive whose header id differs or whose first line is unbounded", () => {
		const content = sessionJsonl([]);
		const mismatched = content.replace(TEST_SESSION_ID, "11111111-2222-3333-4444-555555555555");
		const unbounded = `${JSON.stringify({ type: "session", version: 3, id: TEST_SESSION_ID, pad: "y".repeat(70_000) })}\n`;
		for (const [artifact, error] of [
			[mismatched, /session ID mismatch/i],
			[unbounded, /no line break within 65536 bytes/],
		] as const) {
			const { tree, source, env } = fixture(content);
			archiveOversized(tree, content, source, artifact);
			assert.throws(() => loadHandoffTranscript(source, env), error);
		}
	});
});

import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, it } from "node:test";
import { archiveDestination, getArchiveDbPath } from "../session-archive/archive-files.ts";
import { getSessionRow, openArchiveDb } from "../session-archive/archive-store.ts";
import { makeTempTree, messageEntry, sessionJsonl, userMessage } from "../session-archive/test-helpers.ts";
import { createHandoffHandler as createHandler } from "./command.ts";
import { CWD, HEADER_TIMESTAMP, makeFakeApi, makeFakeCtx, SESSION_ID, withAgentDir } from "./command-test-fixtures.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeArchiveSource(tree: ReturnType<typeof makeTempTree>): string {
	return tree.writeSession(
		SESSION_ID,
		sessionJsonl([messageEntry("u1", null, userMessage("source history"))], { id: SESSION_ID, cwd: CWD }),
	);
}

function writeOversizedArchiveSource(tree: ReturnType<typeof makeTempTree>): string {
	const sessionFile = tree.writeSession(SESSION_ID, sessionJsonl([], { id: SESSION_ID, cwd: CWD }));
	appendFileSync(
		sessionFile,
		'{"type":"custom_message","id":"x1","parentId":null,"timestamp":"2026-08-11T08:49:00.000Z","customType":"fixture","content":"',
	);
	const chunk = "x".repeat(1024 * 1024);
	for (let i = 0; i < 65; i++) appendFileSync(sessionFile, chunk);
	appendFileSync(sessionFile, '","display":true}\n');
	return sessionFile;
}

describe("archive-first handoff", () => {
	it("leaves malformed history active and does not replace or submit", async () => {
		const tree = makeTempTree();
		roots.push(tree.root);
		const sessionFile = tree.writeSession(SESSION_ID, "not-json\n");
		const order: string[] = [];
		const { api, apiCalls } = makeFakeApi(order);
		const fake = makeFakeCtx(order, {
			sessionFile,
			sessionDir: tree.sessionDir,
			expectedParentSession: undefined,
		});

		await withAgentDir(tree.agentDir, async () => {
			await createHandler(api)(
				"--archive goal",
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
		});

		assert.equal(fake.calls.editorDrafts.length, 1);
		assert.equal(fake.calls.newSession, 0);
		assert.equal(fake.calls.sendUserMessage.length, 0);
		assert.deepEqual(apiCalls.setModel, []);
		assert.deepEqual(apiCalls.setThinkingLevel, []);
		assert.deepEqual(fake.replacementCalls.setModel, []);
		assert.deepEqual(fake.replacementCalls.setThinkingLevel, []);
		assert.ok(fake.notifications.some(({ message }) => /malformed session file/i.test(message)));
		assert.equal(existsSync(sessionFile), true);
	});

	it("archives valid history before continuing in the replacement", async () => {
		const tree = makeTempTree();
		roots.push(tree.root);
		const sessionFile = writeArchiveSource(tree);
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const fake = makeFakeCtx(order, {
			sessionFile,
			sessionDir: tree.sessionDir,
			expectedParentSession: undefined,
		});

		await withAgentDir(tree.agentDir, async () => {
			await createHandler(api)(
				"--archive continue after archiving",
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
		});

		assert.equal(fake.calls.newSession, 1);
		assert.equal(fake.calls.sendUserMessage.length, 1);
		assert.equal(existsSync(sessionFile), false);
		assert.ok(fake.notifications.some(({ message }) => message.startsWith("Session archived:")));
		assert.ok(fake.customMessages[0].content.includes("Storage: archived before this handoff"));
	});

	it("points a replacement without handoff tools at the archived transcript path", async () => {
		const tree = makeTempTree();
		roots.push(tree.root);
		const sessionFile = writeArchiveSource(tree);
		const order: string[] = [];
		const { api } = makeFakeApi(order, { active: ["read", "grep", "find", "ls"], registeredOnly: [] });
		const fake = makeFakeCtx(order, {
			sessionFile,
			sessionDir: tree.sessionDir,
			expectedParentSession: undefined,
		});

		await withAgentDir(tree.agentDir, async () => {
			await createHandler(api)(
				"--archive review the diff",
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
		});

		const archivedPath = archiveDestination(tree.archiveRoot, SESSION_ID, HEADER_TIMESTAMP);
		assert.equal(existsSync(archivedPath), true);
		assert.ok(fake.calls.editorDrafts[0].includes(`read the transcript JSONL at ${archivedPath}`));
		assert.ok(
			fake.customMessages[0].content.includes(
				"Storage: archived before this handoff; the Lookup path is its archived location.",
			),
		);
		assert.equal(fake.calls.sendUserMessage.length, 1);
	});

	it("accepts an oversized active source through archive staging", async () => {
		const tree = makeTempTree();
		roots.push(tree.root);
		const sessionFile = writeOversizedArchiveSource(tree);
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const fake = makeFakeCtx(order, {
			sessionFile,
			sessionDir: tree.sessionDir,
			expectedParentSession: undefined,
		});

		await withAgentDir(tree.agentDir, async () => {
			await createHandler(api)(
				"--archive continue after archiving",
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
		});

		assert.equal(fake.calls.newSession, 1);
		assert.equal(fake.calls.sendUserMessage.length, 1);
		assert.equal(existsSync(sessionFile), false);
		assert.ok(fake.notifications.some(({ message }) => message.startsWith("Session archived:")));
	});

	it("does not auto-submit when archive finalization fails", async () => {
		const tree = makeTempTree();
		roots.push(tree.root);
		const sessionFile = writeArchiveSource(tree);
		const collision = archiveDestination(tree.archiveRoot, SESSION_ID, "2026-08-11T08:48:02.226Z");
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const fake = makeFakeCtx(order, {
			sessionFile,
			sessionDir: tree.sessionDir,
			expectedParentSession: undefined,
			beforeWithSession: () => {
				mkdirSync(dirname(collision), { recursive: true });
				writeFileSync(collision, "different archive content");
			},
		});

		await withAgentDir(tree.agentDir, async () => {
			await createHandler(api)(
				"--archive goal",
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
		});

		assert.equal(fake.calls.newSession, 1);
		assert.equal(fake.calls.sendUserMessage.length, 0);
		assert.equal(existsSync(sessionFile), true);
		assert.ok(fake.notifications.some(({ message }) => /Archive finalization failed/i.test(message)));
		assert.deepEqual(fake.replacementCalls.setModel, []);
		assert.deepEqual(fake.replacementCalls.setThinkingLevel, []);
	});

	it("preserves accepted send and does not report pending archive when sendUserMessage throws", async () => {
		const tree = makeTempTree();
		roots.push(tree.root);
		const sessionFile = writeArchiveSource(tree);
		const order: string[] = [];
		const { api } = makeFakeApi(order);
		const fake = makeFakeCtx(order, {
			sessionFile,
			sessionDir: tree.sessionDir,
			expectedParentSession: undefined,
			sendUserMessageError: new Error("simulated sendUserMessage failure"),
		});

		await withAgentDir(tree.agentDir, async () => {
			await createHandler(api)(
				"--archive continue after archiving",
				/* SAFETY: This test controls the fixture and exercises only the asserted contract. */ fake.ctx as never,
			);
		});

		assert.equal(fake.calls.sendUserMessage.length, 1);
		assert.equal(fake.calls.setEditorText.length, 0);
		assert.equal(fake.calls.oldSetEditorText.length, 0);
		assert.equal(fake.calls.newSession, 1);
		assert.equal(existsSync(sessionFile), false);

		const db = openArchiveDb(getArchiveDbPath(tree.archiveRoot));
		try {
			const row = getSessionRow(db, SESSION_ID);
			assert.equal(row?.state, "archived");
		} finally {
			db.close();
		}

		for (const notification of fake.notifications) {
			assert.doesNotMatch(notification.message, /pending/i);
			assert.doesNotMatch(notification.message, /finalization failed/i);
		}
		assert.ok(fake.notifications.some(({ message }) => /inspect the replacement/i.test(message)));
	});
});

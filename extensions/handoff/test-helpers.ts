/** Shared fixtures for handoff history tests. */

import { rmSync, truncateSync, unlinkSync } from "node:fs";
import { afterEach } from "node:test";
import {
	assistantMessage,
	makeTempTree,
	messageEntry,
	registerArchivedSession,
	sessionJsonl,
	TEST_SESSION_ID,
	userMessage,
} from "../session-archive/test-helpers.ts";
import type { HandoffSource } from "./history-reader.ts";
import { clearHandoffParseCache, MAX_TRANSCRIPT_BYTES } from "./transcript.ts";

type TempTree = ReturnType<typeof makeTempTree>;

function defaultHandoffContent(): string {
	return sessionJsonl([
		messageEntry("u1", null, userMessage("initial architecture discussion")),
		messageEntry("a1", "u1", assistantMessage("decided to use a reference-only handoff")),
		messageEntry("u2", "a1", userMessage("resume by implementing the history reader")),
	]);
}

/**
 * Register cleanup for the calling test file and return a factory that writes
 * an active session under a temporary agent directory.
 */
export function useHandoffFixtures() {
	const roots: string[] = [];
	afterEach(() => {
		clearHandoffParseCache();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});
	return (content = defaultHandoffContent()) => {
		const tree = makeTempTree();
		roots.push(tree.root);
		const sessionFile = tree.writeSession(TEST_SESSION_ID, content);
		const source: HandoffSource = {
			version: 1,
			sessionFile,
			sessionId: TEST_SESSION_ID,
			cwd: "/Users/test/Code/project",
		};
		const env = { ...process.env, PI_CODING_AGENT_DIR: tree.agentDir };
		return { tree, content, source, env };
	};
}

/** Finalize the session in the archive, write its artifact, remove the active file, and drop the parse cache. */
export function archiveAndRemoveActive(
	tree: TempTree,
	content: string,
	source: HandoffSource,
	options: Parameters<typeof registerArchivedSession>[3] = {},
): string {
	const archivePath = registerArchivedSession(tree, content, source.sessionFile, options);
	unlinkSync(source.sessionFile);
	clearHandoffParseCache();
	return archivePath;
}

/**
 * Archive the session with an artifact just over the transcript cap. The
 * artifact keeps `artifact`'s bytes (the session by default) and is extended
 * with a sparse zero tail, so the catalog rows still describe `content`.
 */
export function archiveOversized(tree: TempTree, content: string, source: HandoffSource, artifact = content): string {
	const size = MAX_TRANSCRIPT_BYTES + 1;
	const archivePath = archiveAndRemoveActive(tree, content, source, { artifact, fileSize: size });
	truncateSync(archivePath, size);
	return archivePath;
}

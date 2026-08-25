import assert from "node:assert/strict";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { getAgentDir } from "../shared/kstack-config.ts";
import { isNumber } from "../shared/validation.ts";
import {
	ArchiveFileError,
	archiveDestination,
	canonicalizeActiveSource,
	chmodReadOnly,
	fileStat,
	getArchiveRoot,
	hashFile,
	isArchiveWriteTarget,
	isPathInside,
	moveToArchive,
	pathsReferToSameFile,
	readUtf8Ranges,
	validateSessionId,
} from "./archive-files.ts";
import { sha256Hex } from "./session-jsonl.ts";
import { makeTempTree, richSessionJsonl, TEST_SESSION_ID } from "./test-helpers.ts";

describe("paths", () => {
	it("honors PI_CODING_AGENT_DIR and falls back to ~/.pi/agent", () => {
		assert.equal(getAgentDir({ PI_CODING_AGENT_DIR: "/tmp/custom-agent" }), "/tmp/custom-agent");
		assert.equal(getAgentDir({ PI_CODING_AGENT_DIR: "~/custom" }), join(process.env.HOME!, "custom"));
		assert.ok(getAgentDir({}).endsWith("/.pi/agent"));
		assert.ok(getArchiveRoot({ PI_CODING_AGENT_DIR: "/tmp/custom-agent" }).endsWith("/archive"));
	});

	it("builds destinations by UTC year/month and session id", () => {
		const dest = archiveDestination("/root/archive", TEST_SESSION_ID, "2026-08-11T23:30:00.000-05:00");
		assert.equal(dest, `/root/archive/sessions/2026/08/${TEST_SESSION_ID}/session.jsonl`);
		const dst2 = archiveDestination("/root/archive", TEST_SESSION_ID, "2026-01-01T00:30:00.000+01:00");
		assert.equal(dst2, `/root/archive/sessions/2025/12/${TEST_SESSION_ID}/session.jsonl`);
	});

	it("requires canonical UUID session ids and valid timestamps", () => {
		validateSessionId(TEST_SESSION_ID);
		validateSessionId(TEST_SESSION_ID.toUpperCase());
		assert.throws(() => validateSessionId("../escape"), ArchiveFileError);
		assert.throws(() => validateSessionId("safe-but-not-a-uuid"), ArchiveFileError);
		assert.throws(() => validateSessionId("a/b"), ArchiveFileError);
		assert.throws(() => validateSessionId(".."), ArchiveFileError);
		assert.throws(() => validateSessionId(""), ArchiveFileError);
		assert.throws(() => archiveDestination("/r", TEST_SESSION_ID, "not-a-date"), ArchiveFileError);
	});

	it("computes path containment correctly", () => {
		assert.ok(isPathInside("/a/b/c", "/a/b"));
		assert.ok(isPathInside("/a/b", "/a/b"));
		assert.ok(!isPathInside("/a/bc", "/a/b"));
		assert.ok(!isPathInside("/a", "/a/b"));
	});
});

describe("canonicalizeActiveSource", () => {
	it("accepts a regular .jsonl inside the active session dir", () => {
		const tree = makeTempTree();
		const path = tree.writeSession(TEST_SESSION_ID, richSessionJsonl());
		assert.equal(canonicalizeActiveSource(path, tree.sessionDir, tree.archiveRoot), realpathSync(path));
	});

	it("rejects symlinks even when they resolve inside the session dir", () => {
		const tree = makeTempTree();
		const real = tree.writeSession(TEST_SESSION_ID, richSessionJsonl());
		const link = join(tree.sessionDir, "linked.jsonl");
		symlinkSync(real, link);
		assert.throws(() => canonicalizeActiveSource(link, tree.sessionDir, tree.archiveRoot), /symlink/);
	});

	it("rejects files outside the active session dir", () => {
		const tree = makeTempTree();
		const outside = join(tree.root, "elsewhere.jsonl");
		writeFileSync(outside, richSessionJsonl());
		assert.throws(() => canonicalizeActiveSource(outside, tree.sessionDir, tree.archiveRoot), /outside the active/);
	});

	it("rejects files inside the archive root", () => {
		const tree = makeTempTree();
		mkdirSync(tree.archiveRoot, { recursive: true });
		const inside = join(tree.archiveRoot, "session.jsonl");
		writeFileSync(inside, richSessionJsonl());
		assert.throws(() => canonicalizeActiveSource(inside, tree.sessionDir, tree.archiveRoot), /inside the archive/);
	});

	it("rejects non-jsonl and missing files", () => {
		const tree = makeTempTree();
		const txt = join(tree.sessionDir, "notes.txt");
		writeFileSync(txt, "hi");
		assert.throws(() => canonicalizeActiveSource(txt, tree.sessionDir, tree.archiveRoot), /\.jsonl/);
		assert.throws(
			() => canonicalizeActiveSource(join(tree.sessionDir, "gone.jsonl"), tree.sessionDir, tree.archiveRoot),
			/does not exist/,
		);
	});
});

describe("moveToArchive", () => {
	it("renames atomically, removing the source and preserving bytes", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const source = tree.writeSession(TEST_SESSION_ID, content);
		const dest = archiveDestination(tree.archiveRoot, TEST_SESSION_ID, "2026-08-11T08:48:02.226Z");
		moveToArchive(source, dest, sha256Hex(content), content.length);
		assert.ok(!existsSync(source));
		assert.equal(readFileSync(dest, "utf8"), content);
	});

	it("finishes idempotently when the destination already has identical bytes", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const source = tree.writeSession(TEST_SESSION_ID, content);
		const dest = archiveDestination(tree.archiveRoot, TEST_SESSION_ID, "2026-08-11T08:48:02.226Z");
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, content);
		moveToArchive(source, dest, sha256Hex(content), content.length);
		assert.ok(!existsSync(source));
		assert.equal(readFileSync(dest, "utf8"), content);
	});

	it("refuses to overwrite a destination with different bytes, preserving the source", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const source = tree.writeSession(TEST_SESSION_ID, content);
		const dest = archiveDestination(tree.archiveRoot, TEST_SESSION_ID, "2026-08-11T08:48:02.226Z");
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, "different content entirely");
		assert.throws(() => moveToArchive(source, dest, sha256Hex(content), content.length), /different content/);
		assert.ok(existsSync(source));
		assert.equal(readFileSync(dest, "utf8"), "different content entirely");
	});

	it("falls back to a verified copy on EXDEV, leaving no temp files", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const source = tree.writeSession(TEST_SESSION_ID, content);
		const dest = archiveDestination(tree.archiveRoot, TEST_SESSION_ID, "2026-08-11T08:48:02.226Z");
		const exdev = () => {
			const err = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ new Error(
				"cross-device",
			) as NodeJS.ErrnoException;
			err.code = "EXDEV";
			throw err;
		};
		moveToArchive(source, dest, sha256Hex(content), content.length, exdev);
		assert.ok(!existsSync(source));
		assert.equal(readFileSync(dest, "utf8"), content);
		// no temp files left in the destination directory
		const leftovers = readdirSync(dirname(dest));
		assert.deepEqual(leftovers, ["session.jsonl"]);
	});

	it("refuses to move or delete a source that changed after staging", () => {
		const tree = makeTempTree();
		const original = richSessionJsonl();
		const source = tree.writeSession(TEST_SESSION_ID, original);
		const dest = archiveDestination(tree.archiveRoot, TEST_SESSION_ID, "2026-08-11T08:48:02.226Z");
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, original);
		writeFileSync(source, `${original}changed after staging\n`);
		assert.throws(
			() => moveToArchive(source, dest, sha256Hex(original), original.length),
			/changed after it was staged/,
		);
		assert.ok(existsSync(source));
		assert.equal(readFileSync(dest, "utf8"), original);
	});

	it("surfaces non-EXDEV rename failures without touching the source", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const source = tree.writeSession(TEST_SESSION_ID, content);
		const dest = archiveDestination(tree.archiveRoot, TEST_SESSION_ID, "2026-08-11T08:48:02.226Z");
		const eperm = () => {
			const err = /* SAFETY: This test controls the fixture and exercises only the asserted contract. */ new Error(
				"not permitted",
			) as NodeJS.ErrnoException;
			err.code = "EPERM";
			throw err;
		};
		assert.throws(() => moveToArchive(source, dest, sha256Hex(content), content.length, eperm), /not permitted/);
		assert.ok(existsSync(source));
		assert.ok(!existsSync(dest));
	});
});

describe("chmodReadOnly", () => {
	it("marks archived files 0444 on POSIX", () => {
		if (process.platform === "win32") return;
		const tree = makeTempTree();
		const path = tree.writeSession(TEST_SESSION_ID, richSessionJsonl());
		chmodReadOnly(path);
		assert.equal(lstatSync(path).mode & 0o777, 0o444);
	});
});

describe("isArchiveWriteTarget", () => {
	it("blocks absolute and cwd-relative paths inside the archive root", () => {
		const tree = makeTempTree();
		mkdirSync(tree.archiveRoot, { recursive: true });
		const inside = join(tree.archiveRoot, "sessions", "x", "session.jsonl");
		assert.ok(isArchiveWriteTarget(inside, tree.sessionDir, tree.archiveRoot));
		// Relative path from a cwd inside the archive
		assert.ok(isArchiveWriteTarget("session.jsonl", join(tree.archiveRoot, "sessions", "x"), tree.archiveRoot));
		// Non-existent target inside the archive
		assert.ok(isArchiveWriteTarget(join(tree.archiveRoot, "new-file.txt"), "/tmp", tree.archiveRoot));
	});

	it("blocks symlink aliases that resolve into the archive root", () => {
		const tree = makeTempTree();
		mkdirSync(tree.archiveRoot, { recursive: true });
		const real = join(tree.archiveRoot, "real.jsonl");
		writeFileSync(real, "x");
		const alias = join(tree.root, "alias.jsonl");
		symlinkSync(real, alias);
		assert.ok(isArchiveWriteTarget(alias, tree.sessionDir, tree.archiveRoot));
	});

	it("blocks new files beneath a symlinked archive directory", () => {
		const tree = makeTempTree();
		mkdirSync(join(tree.archiveRoot, "sessions"), { recursive: true });
		const alias = join(tree.root, "archive-alias");
		symlinkSync(join(tree.archiveRoot, "sessions"), alias);
		assert.ok(isArchiveWriteTarget(join(alias, "new", "session.jsonl"), tree.sessionDir, tree.archiveRoot));
	});

	it("allows paths outside the archive root", () => {
		const tree = makeTempTree();
		mkdirSync(tree.archiveRoot, { recursive: true });
		assert.ok(!isArchiveWriteTarget(join(tree.sessionDir, "active.jsonl"), tree.sessionDir, tree.archiveRoot));
		// Prefix trap: archive sibling whose name starts with the same string
		assert.ok(!isArchiveWriteTarget(`${tree.archiveRoot}-backup/x.jsonl`, "/tmp", tree.archiveRoot));
	});
});

describe("pathsReferToSameFile", () => {
	it("recognizes the same file through a symlinked parent directory", () => {
		const tree = makeTempTree();
		const source = tree.writeSession(TEST_SESSION_ID, richSessionJsonl());
		const aliasDir = join(tree.root, "session-alias");
		symlinkSync(tree.sessionDir, aliasDir);
		assert.ok(pathsReferToSameFile(source, join(aliasDir, source.split("/").at(-1)!)));
	});
});

describe("fileStat", () => {
	it("returns file size and mtimeMs", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const path = tree.writeSession(TEST_SESSION_ID, content);
		const { size, mtimeMs } = fileStat(path);
		assert.equal(size, content.length);
		assert.ok(isNumber(mtimeMs) && Number.isFinite(mtimeMs) && mtimeMs > 0);
	});
});

describe("hashFile", () => {
	it("hashes file bytes", () => {
		const tree = makeTempTree();
		const content = richSessionJsonl();
		const path = tree.writeSession(TEST_SESSION_ID, content);
		const { sha256, size } = hashFile(path);
		assert.equal(sha256, sha256Hex(content));
		assert.equal(size, content.length);
	});
});

describe("readUtf8Ranges", () => {
	it("reads exact non-contiguous multibyte ranges without loading raw JSON from SQLite", () => {
		const tree = makeTempTree();
		const content = "zero\nhéllo 👋\nlast\n";
		const path = tree.writeSession(TEST_SESSION_ID, content);
		const secondOffset = Buffer.byteLength("zero\n");
		const secondLength = Buffer.byteLength("héllo 👋");
		assert.deepEqual(
			readUtf8Ranges(path, [
				{ offset: secondOffset, length: secondLength },
				{ offset: Buffer.byteLength("zero\nhéllo 👋\n"), length: 4 },
			]),
			["héllo 👋", "last"],
		);
	});

	it("rejects ranges beyond the archived file", () => {
		const tree = makeTempTree();
		const path = tree.writeSession(TEST_SESSION_ID, "short");
		assert.throws(() => readUtf8Ranges(path, [{ offset: 3, length: 10 }]), /ended inside byte range/);
	});
});

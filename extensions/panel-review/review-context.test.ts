import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadProjectContextFiles } from "@earendil-works/pi-coding-agent";
import { contextFilesTouchChangedContent } from "./review-context.ts";

function tree() {
	const root = mkdtempSync(join(tmpdir(), "panel-context-"));
	const repo = join(root, "repo");
	const agentDir = join(root, "agent");
	mkdirSync(repo);
	mkdirSync(agentDir);
	return { root, repo, agentDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("installed Pi context loader", () => {
	it("discovers every supported spelling with documented precedence", () => {
		const names = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
		for (const selected of names) {
			const fixture = tree();
			try {
				writeFileSync(join(fixture.repo, selected), `selected ${selected}`);
				const loaded = loadProjectContextFiles({ cwd: fixture.repo, agentDir: fixture.agentDir });
				assert.equal(loaded.at(-1)?.content, `selected ${selected}`);
			} finally {
				fixture.cleanup();
			}
		}
		const fixture = tree();
		try {
			for (const name of names) writeFileSync(join(fixture.repo, name), name);
			const loaded = loadProjectContextFiles({ cwd: fixture.repo, agentDir: fixture.agentDir });
			assert.equal(loaded.at(-1)?.path, join(fixture.repo, "AGENTS.override.md"));
		} finally {
			fixture.cleanup();
		}
	});

	it("does not load a U+FEFF-prefixed lookalike context filename", () => {
		const fixture = tree();
		try {
			writeFileSync(join(fixture.repo, "\uFEFFAGENTS.md"), "lookalike guidance");
			const loaded = loadProjectContextFiles({ cwd: fixture.repo, agentDir: fixture.agentDir });
			assert.equal(loaded.length, 0);
		} finally {
			fixture.cleanup();
		}
	});
});

describe("contextFilesTouchChangedContent", () => {
	it("keeps unchanged regular and safe symlink context enabled", () => {
		const fixture = tree();
		try {
			writeFileSync(join(fixture.repo, "guidance.md"), "safe");
			symlinkSync("guidance.md", join(fixture.repo, "AGENTS.md"));
			assert.equal(
				contextFilesTouchChangedContent({ ...fixture, reviewRoot: fixture.repo, changedPaths: ["src.ts"] }),
				false,
			);
		} finally {
			fixture.cleanup();
		}
	});

	it("treats a U+FEFF-prefixed lookalike as a distinct path while suppressing genuinely changed context", () => {
		const fixture = tree();
		try {
			writeFileSync(join(fixture.repo, "AGENTS.md"), "trusted safe guidance");
			writeFileSync(join(fixture.repo, "\uFEFFAGENTS.md"), "lookalike content");
			assert.equal(
				contextFilesTouchChangedContent({
					...fixture,
					reviewRoot: fixture.repo,
					changedPaths: ["\uFEFFAGENTS.md"],
				}),
				false,
			);
			assert.equal(
				contextFilesTouchChangedContent({
					...fixture,
					reviewRoot: fixture.repo,
					changedPaths: ["AGENTS.md"],
				}),
				true,
			);
		} finally {
			fixture.cleanup();
		}
	});

	it("disables context for a changed symlink target or intermediate link", () => {
		const fixture = tree();
		try {
			mkdirSync(join(fixture.repo, "links"));
			writeFileSync(join(fixture.repo, "changed.md"), "changed");
			symlinkSync("../changed.md", join(fixture.repo, "links", "guidance.md"));
			symlinkSync("links/guidance.md", join(fixture.repo, "AGENTS.md"));
			assert.equal(
				contextFilesTouchChangedContent({ ...fixture, reviewRoot: fixture.repo, changedPaths: ["changed.md"] }),
				true,
			);
			assert.equal(
				contextFilesTouchChangedContent({ ...fixture, reviewRoot: fixture.repo, changedPaths: ["links/guidance.md"] }),
				true,
			);
		} finally {
			fixture.cleanup();
		}
	});

	it("covers agent context resolving into changed review content", () => {
		const fixture = tree();
		try {
			writeFileSync(join(fixture.repo, "changed.md"), "changed");
			symlinkSync(join(fixture.repo, "changed.md"), join(fixture.agentDir, "AGENTS.md"));
			assert.equal(
				contextFilesTouchChangedContent({ ...fixture, reviewRoot: fixture.repo, changedPaths: ["changed.md"] }),
				true,
			);
		} finally {
			fixture.cleanup();
		}
	});

	it("conservatively disables broken, cyclic, direct, and injected provenance failures", () => {
		const fixture = tree();
		try {
			symlinkSync("missing.md", join(fixture.repo, "AGENTS.md"));
			assert.equal(
				contextFilesTouchChangedContent({ ...fixture, reviewRoot: fixture.repo, changedPaths: ["src.ts"] }),
				true,
			);
			rmSync(join(fixture.repo, "AGENTS.md"));
			symlinkSync("CLAUDE.md", join(fixture.repo, "AGENTS.md"));
			symlinkSync("AGENTS.md", join(fixture.repo, "CLAUDE.md"));
			assert.equal(
				contextFilesTouchChangedContent({ ...fixture, reviewRoot: fixture.repo, changedPaths: ["src.ts"] }),
				true,
			);
			assert.equal(
				contextFilesTouchChangedContent({ ...fixture, reviewRoot: fixture.repo, changedPaths: ["AGENTS.MD"] }),
				true,
			);
			assert.equal(
				contextFilesTouchChangedContent({
					...fixture,
					reviewRoot: fixture.repo,
					changedPaths: ["src.ts"],
					deps: { loadContextFiles: () => [{ path: join(fixture.repo, "missing"), content: "" }] },
				}),
				true,
			);
		} finally {
			fixture.cleanup();
		}
	});
});

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const EXTENSIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MUTATING_EXTENSIONS = ["fast-implement", "plan-implement", "pr-autopilot", "land"] as const;

function source(path: string): string {
	return readFileSync(path, "utf8");
}

describe("configured VCS adapter boundary", () => {
	it("loads and constructs exactly one configured backend in every mutating entrypoint", () => {
		for (const extension of MUTATING_EXTENSIONS) {
			const text = source(join(EXTENSIONS_DIR, extension, "index.ts"));
			assert.equal(text.match(/loadVcsBackend\s*\(/g)?.length, 1, `${extension} must load VCS config once`);
			assert.equal(text.match(/createVcsBackend\s*\(/g)?.length, 1, `${extension} must construct one backend`);
			assert.doesNotMatch(text, /createGitBackend|new GitBackend|new JjBackend/);
		}
	});

	it("owns reusable workflow preflight below the Pi adapter", () => {
		for (const [extension, workflow] of [
			["fast-implement", "runner.ts"],
			["pr-autopilot", "driver.ts"],
		] as const) {
			assert.doesNotMatch(source(join(EXTENSIONS_DIR, extension, "index.ts")), /\.preflight\s*\(/);
			assert.equal(source(join(EXTENSIONS_DIR, extension, workflow)).match(/\.preflight\s*\(/g)?.length, 1);
		}
	});

	it("keeps direct Git and jj mutations out of workflow modules", () => {
		const directMutation =
			/(?:pi\.)?exec\s*\(\s*["'](?:git|jj)["']\s*,\s*\[\s*["'](?:add|commit|switch|checkout|merge|rebase|push|fetch|restore|clean|worktree|branch|new|describe|bookmark|abandon)["']/;
		for (const extension of MUTATING_EXTENSIONS) {
			const root = join(EXTENSIONS_DIR, extension);
			for (const relative of readdirSync(root, { recursive: true, encoding: "utf8" })) {
				if (!relative.endsWith(".ts") || relative.endsWith(".test.ts")) continue;
				assert.doesNotMatch(source(join(root, relative)), directMutation, `${extension}/${relative}`);
			}
		}
	});
});

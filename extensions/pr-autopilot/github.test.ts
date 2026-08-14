import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isForbiddenStagingPath, parsePorcelainPaths } from "./github.ts";

describe("porcelain and forbidden paths", () => {
	it("parses git status --porcelain paths including renames", () => {
		const paths = parsePorcelainPaths(" M src/a.ts\n?? new.ts\nR  old.ts -> dest.ts\n");
		assert.deepEqual(paths, ["src/a.ts", "new.ts", "dest.ts"]);
	});

	it("rejects secrets and workflow files", () => {
		assert.equal(isForbiddenStagingPath(".env"), true);
		assert.equal(isForbiddenStagingPath("apps/web/.env.local"), true);
		assert.equal(isForbiddenStagingPath(".github/workflows/ci.yml"), true);
		assert.equal(isForbiddenStagingPath("src/index.ts"), false);
	});
});

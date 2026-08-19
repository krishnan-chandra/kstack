import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const REPO_ROOT = import.meta.dirname;
const EXPECTED_EXTENSIONS = [
	"handoff",
	"jj-stacked-prs",
	"kstack-router",
	"land",
	"panel-review",
	"parallel-agents",
	"plan-implement",
	"pr-autopilot",
	"session-archive",
	"steering-swap",
];

test("package.json points Pi at the TypeScript aggregator and keeps skills", () => {
	const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
	assert.deepEqual(pkg.pi, {
		extensions: ["./kstack.ts"],
		skills: ["./skills"],
	});
});

test("the aggregator lists every extension factory in the documented order", () => {
	const source = readFileSync(join(REPO_ROOT, "kstack.ts"), "utf8");
	const names = [...source.matchAll(/name:\s*"([^"]+)"/g)].map((match) => match[1]);
	assert.deepEqual(names, EXPECTED_EXTENSIONS);
	for (const name of EXPECTED_EXTENSIONS) {
		assert.match(source, new RegExp(`./extensions/${name}/index.ts`));
		assert.equal(existsSync(join(REPO_ROOT, "extensions", name, "index.ts")), true);
	}
});

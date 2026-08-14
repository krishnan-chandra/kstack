import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFastImplementArgs } from "./command.ts";
import { resolveRole, validateConfig } from "./config.ts";
import { buildChildArgs } from "./runner.ts";

test("parses bounded fast implementation requests", () => {
	const result = parseFastImplementArgs("--worktree --change-kind feature Add a test");
	assert.equal(result.ok, true);
	if (result.ok) assert.deepEqual(result.request, { task: "Add a test", workLocation: "worktree", changeKind: "feature" });
	assert.equal(parseFastImplementArgs("--stack no").ok, false);
});
test("validates an independent fast-implement config", () => {
	const config = validateConfig({ implementer: { model: "openai/example", thinking: "medium" }, timeoutMinutes: 5 });
	assert.equal(config.ok, true);
	assert.equal(validateConfig({ implementer: { model: "bad" } }).ok, false);
	assert.equal(resolveRole(null, (provider) => provider === "openai").ok, true);
});
test("child keeps skills and context but disables recursive runtime features", () => {
	const args = buildChildArgs("openai/example:medium", "/private/prompt", "/private/task");
	assert.ok(args.includes("--no-extensions")); assert.ok(args.includes("--no-prompt-templates")); assert.ok(!args.includes("--no-skills")); assert.ok(args.includes("--no-session"));
});

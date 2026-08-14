import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFastImplementArgs } from "./command.ts";
import { ALLOWED_IMPLEMENTERS, DEFAULT_IMPLEMENTERS, resolveRole, validateConfig } from "./config.ts";
import { buildChildArgs } from "./runner.ts";

test("parses bounded fast implementation requests", () => {
	const result = parseFastImplementArgs("--worktree --change-kind feature Add a test");
	assert.equal(result.ok, true);
	if (result.ok) assert.deepEqual(result.request, { task: "Add a test", workLocation: "worktree", changeKind: "feature" });
	assert.equal(parseFastImplementArgs("--stack no").ok, false);
	assert.equal(parseFastImplementArgs("--worktree --worktree task").ok, false);
});
test("preserves quotes and contractions in the raw task suffix", () => {
	const contraction = parseFastImplementArgs("Don't break the \"quoted\" path check");
	assert.equal(contraction.ok, true);
	if (contraction.ok) assert.equal(contraction.request.task, 'Don\'t break the "quoted" path check');
	const quoted = parseFastImplementArgs('--change-kind "bug-fix" -- "Fix the narrow bug"');
	assert.equal(quoted.ok, true);
	if (quoted.ok) assert.deepEqual(quoted.request, { task: "Fix the narrow bug", workLocation: "current", changeKind: "bug-fix" });
});
test("validates the bounded fast-implement implementer set", () => {
	assert.deepEqual(ALLOWED_IMPLEMENTERS, [
		{ model: "openai/gpt-5.6-sol", thinking: "low" },
		{ model: "openrouter/x-ai/grok-4.6", thinking: "high" },
		{ model: "anthropic/claude-opus-5", thinking: "medium" },
	]);
	assert.deepEqual(DEFAULT_IMPLEMENTERS, ALLOWED_IMPLEMENTERS);
	for (const spec of ALLOWED_IMPLEMENTERS) {
		const config = validateConfig({ implementer: { model: spec.model }, timeoutMinutes: 5 });
		assert.equal(config.ok, true);
		if (config.ok) assert.deepEqual(config.config.implementer, spec);
	}
	assert.equal(validateConfig({ implementer: { model: "openai/gpt-5.6-terra", thinking: "medium" } }).ok, false);
	assert.equal(validateConfig({ implementer: { model: "openai/gpt-5.6-sol", thinking: "high" } }).ok, false);
	assert.equal(validateConfig({ implementer: { model: "bad" } }).ok, false);
});
test("resolves only authenticated bounded implementers", () => {
	const openaiOnly = resolveRole(null, (provider) => provider === "openai");
	assert.equal(openaiOnly.ok, true);
	if (openaiOnly.ok) assert.deepEqual(openaiOnly.role.implementer, ALLOWED_IMPLEMENTERS[0]);
	const anthropicOnly = resolveRole(null, (provider) => provider === "anthropic");
	assert.equal(anthropicOnly.ok, true);
	if (anthropicOnly.ok) assert.deepEqual(anthropicOnly.role.implementer, { model: "anthropic/claude-opus-5", thinking: "medium" });
	assert.equal(resolveRole(null, () => false).ok, false);
});
test("child keeps skills and context but disables recursive runtime features", () => {
	const args = buildChildArgs("openai/example:medium", "/private/prompt", "/private/task");
	assert.ok(args.includes("--no-extensions")); assert.ok(args.includes("--no-prompt-templates")); assert.ok(!args.includes("--no-skills")); assert.ok(args.includes("--no-session"));
});

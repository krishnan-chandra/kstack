import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseFanoutSpec } from "./fanout.ts";

for (const skill of ["arena", "swarm", "simplify"]) {
	test(`${skill} shipped fanout example passes the production schema`, () => {
		const markdown = readFileSync(new URL(`../../../skills/${skill}/SKILL.md`, import.meta.url), "utf8");
		const blocks = [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => match[1] ?? "");
		const template = blocks.find((block) => block.includes('"tasks"'));
		assert.ok(template);
		const expanded = template
			.replaceAll("<repo-root>", "/fixture/repo")
			.replaceAll("<worker-cwd>", "/fixture/repo")
			.replaceAll("<candidate-worktree-or-dir>", "/fixture/candidate")
			.replaceAll(/<(?:model|worker-model|provider\/model\[:thinking\])>/g, "provider/model")
			.replaceAll(/<(?:run-id|candidate-label|label)>/g, "example");
		const parsed = parseFanoutSpec(JSON.parse(expanded));
		assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
	});
}

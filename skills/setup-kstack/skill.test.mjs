import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillDir = dirname(fileURLToPath(import.meta.url));

test("setup-kstack local markdown links resolve", async () => {
	const skill = await readFile(resolve(skillDir, "SKILL.md"), "utf8");
	for (const link of skill.matchAll(/\]\(([^)#]+\.md)(?:#[^)]+)?\)/g)) {
		await access(resolve(skillDir, link[1]));
	}
});

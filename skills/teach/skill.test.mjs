import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const skillDir = dirname(fileURLToPath(import.meta.url));

test("teach references its sibling skills", async () => {
	for (const sibling of ["../how/SKILL.md", "../why/SKILL.md", "../unslop/SKILL.md"]) {
		await access(resolve(skillDir, sibling));
	}
});

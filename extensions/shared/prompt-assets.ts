import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Read a bundled Markdown asset from an extension's prompts or playbooks directory. */
export function readPromptAsset(dir: string, name: string): string {
	return readFileSync(join(dir, name), "utf8");
}

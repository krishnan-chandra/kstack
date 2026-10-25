import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Shared non-mutating role contract; tools remain available for inspection. */
export const READ_ONLY_PROMPT_FILE = join(import.meta.dirname, "prompts", "read-only.md");

/** Planning-council seat contract: review and cross-examination formats. */
export const COUNCIL_SEAT_PROMPT_FILE = join(import.meta.dirname, "prompts", "council-seat.md");

/** Read a bundled Markdown asset from an extension's prompts or playbooks directory. */
export function readPromptAsset(dir: string, name: string): string {
	return readFileSync(join(dir, name), "utf8");
}

/**
 * Land per-repository merge configuration.
 *
 * Config lives in the `"land"` section of `$PI_CODING_AGENT_DIR/kstack.json`:
 *
 *   {
 *     "land": {
 *       "repos": {
 *         "owner/repo": "squash",
 *         "owner/repo2": "rebase"
 *       }
 *     }
 *   }
 *
 * When a repository is listed, the configured method (squash or rebase) is
 * used automatically and the method-selection and confirmation prompts are
 * skipped. Kstack policy disallows merge commits everywhere, so "merge" is
 * never a valid configured method.
 */

import { loadKstackSection } from "../shared/kstack-config.ts";
import type { MergeMethod } from "./types.ts";

export interface LandConfig {
	repos: Record<string, MergeMethod>;
}

const VALID_METHODS: ReadonlySet<string> = new Set(["squash", "rebase"]);

/**
 * Load the land section from kstack.json and return the per-repo method map.
 * Silently ignores unknown repos and invalid methods.
 */
export function loadLandConfig(): LandConfig {
	const section = loadKstackSection("land");
	if (section.status !== "found") return { repos: {} };
	const value = section.value;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { repos: {} };
	const obj = value as Record<string, unknown>;
	if (typeof obj.repos !== "object" || obj.repos === null || Array.isArray(obj.repos)) return { repos: {} };
	const repos: Record<string, MergeMethod> = {};
	for (const [key, method] of Object.entries(obj.repos)) {
		if (typeof method === "string" && VALID_METHODS.has(method)) {
			repos[key] = method as MergeMethod;
		}
	}
	return { repos };
}

/**
 * Look up the configured merge method for a repository.
 * Returns undefined when no per-repo config exists.
 */
export function getRepoMethod(config: LandConfig, nameWithOwner: string): MergeMethod | undefined {
	return config.repos[nameWithOwner];
}

import type { BoundaryValue } from "../shared/validation.ts";
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

import { isMergeMethod } from "../shared/github.ts";
import { type ConfigLoad, loadValidatedSection } from "../shared/kstack-config.ts";
import { isRecord } from "../shared/narrow.ts";
import type { MergeMethod } from "./types.ts";

export interface LandConfig {
	repos: Record<string, MergeMethod>;
}

export function validateLandConfig(
	value: BoundaryValue,
): { ok: true; config: LandConfig } | { ok: false; error: string } {
	if (!isRecord(value)) {
		return { ok: false, error: '"land" must be an object.' };
	}
	if (value.repos === undefined) {
		return { ok: true, config: { repos: {} } };
	}
	if (!isRecord(value.repos)) {
		return { ok: false, error: '"land.repos" must be an object mapping "owner/repo" to "squash" or "rebase".' };
	}
	const repos: Record<string, MergeMethod> = {};
	for (const [key, method] of Object.entries(value.repos)) {
		if (!isMergeMethod(method)) {
			return { ok: false, error: `land.repos["${key}"] must be "squash" or "rebase".` };
		}
		repos[key] = method;
	}
	return { ok: true, config: { repos } };
}

/**
 * Load the land section from kstack.json and return the per-repo method map.
 * A malformed section surfaces as `{ status: "invalid" }` instead of silently
 * degrading to an empty config.
 */
export function loadLandConfig(): ConfigLoad<LandConfig> {
	return loadValidatedSection("land", validateLandConfig);
}

/**
 * Look up the configured merge method for a repository.
 * Returns undefined when no per-repo config exists.
 */
export function getRepoMethod(config: LandConfig, nameWithOwner: string): MergeMethod | undefined {
	return config.repos[nameWithOwner];
}

import { loadKstackSection } from "../kstack-config.ts";
import { type BoundaryValue, isObject, type JsonObject } from "../validation.ts";

/* exported: shared VCS backend contract */
export type VcsBackendId = "git" | "jj" | "graphite";

/* exported: shared VCS backend contract */
export interface VcsBackendConfig {
	backend: VcsBackendId;
	warnings: string[];
}

const DEFAULT_BACKEND: VcsBackendId = "git";

function parseBackend(value: BoundaryValue): VcsBackendId | undefined {
	if (!isObject(value) || value === null || Array.isArray(value)) return undefined;
	const backend = /* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ (
		value as JsonObject
	).backend;
	return backend === "git" || backend === "jj" || backend === "graphite" ? backend : undefined;
}

/**
 * Load the user-wide VCS choice. Repository-specific overrides are deliberately
 * unsupported; every K-Stack mutation flow in one agent environment uses the
 * same backend.
 */
export function loadVcsBackend(env: NodeJS.ProcessEnv = process.env): VcsBackendConfig {
	const section = loadKstackSection("vcs", env);
	if (section.status === "missing") {
		return { backend: DEFAULT_BACKEND, warnings: [] };
	}
	if (section.status === "invalid") {
		return {
			backend: DEFAULT_BACKEND,
			warnings: [`Invalid ${section.path}: ${section.error} Defaulting to the git backend.`],
		};
	}
	const backend = parseBackend(section.value);
	if (!backend) {
		return {
			backend: DEFAULT_BACKEND,
			warnings: [
				`Invalid ${section.path}: "vcs.backend" must be "git", "jj", or "graphite". Defaulting to the git backend.`,
			],
		};
	}
	return { backend, warnings: [] };
}

import { loadKstackSection } from "../kstack-config.ts";

/* exported: shared VCS backend contract */
export type VcsBackendId = "git" | "jj";

/* exported: shared VCS backend contract */
export interface VcsBackendConfig {
	backend: VcsBackendId;
	warnings: string[];
	path: string;
}

const DEFAULT_BACKEND: VcsBackendId = "git";

function parseBackend(value: unknown): VcsBackendId | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const backend = (value as Record<string, unknown>).backend;
	return backend === "git" || backend === "jj" ? backend : undefined;
}

/**
 * Load the user-wide VCS choice. Repository-specific overrides are deliberately
 * unsupported; every K-Stack mutation flow in one agent environment uses the
 * same backend.
 */
export function loadVcsBackend(env: NodeJS.ProcessEnv = process.env): VcsBackendConfig {
	const section = loadKstackSection("vcs", env);
	if (section.status === "missing") {
		return { backend: DEFAULT_BACKEND, warnings: [], path: section.path };
	}
	if (section.status === "invalid") {
		return {
			backend: DEFAULT_BACKEND,
			warnings: [`Invalid ${section.path}: ${section.error} Defaulting to the git backend.`],
			path: section.path,
		};
	}
	const backend = parseBackend(section.value);
	if (!backend) {
		return {
			backend: DEFAULT_BACKEND,
			warnings: [`Invalid ${section.path}: "vcs.backend" must be "git" or "jj". Defaulting to the git backend.`],
			path: section.path,
		};
	}
	return { backend, warnings: [], path: section.path };
}

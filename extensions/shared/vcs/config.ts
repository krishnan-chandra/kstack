import { loadKstackSection } from "../kstack-config.ts";
import { asRecord } from "../narrow.ts";
import type { JsonObject } from "../validation.ts";

/* exported: shared VCS backend contract */
export type VcsBackendId = "git" | "jj" | "graphite";

/* exported: shared VCS backend contract */
export type VcsBackendConfig =
	| { backend: "git"; gitStackProvider: "github" | "none"; warnings: string[] }
	| { backend: "jj"; warnings: string[] }
	| { backend: "graphite"; warnings: string[] };

const DEFAULT_BACKEND: VcsBackendId = "git";
const DEFAULT_GIT_STACK_PROVIDER = "github" as const;

function parseBackend(value: JsonObject): VcsBackendId | undefined {
	const backend = value.backend;
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
		return { backend: DEFAULT_BACKEND, gitStackProvider: DEFAULT_GIT_STACK_PROVIDER, warnings: [] };
	}
	if (section.status === "invalid") {
		return {
			backend: DEFAULT_BACKEND,
			gitStackProvider: DEFAULT_GIT_STACK_PROVIDER,
			warnings: [`Invalid ${section.path}: ${section.error} Defaulting to the git backend.`],
		};
	}
	const value = asRecord(section.value);
	const backend = value ? parseBackend(value) : undefined;
	if (!backend) {
		return {
			backend: DEFAULT_BACKEND,
			gitStackProvider: DEFAULT_GIT_STACK_PROVIDER,
			warnings: [
				`Invalid ${section.path}: "vcs.backend" must be "git", "jj", or "graphite". Defaulting to the git backend.`,
			],
		};
	}
	const configured = value?.stackProvider;
	const warnings: string[] = [];
	let gitStackProvider: "github" | "none" = DEFAULT_GIT_STACK_PROVIDER;
	if (backend === "git") {
		if (configured === "github" || configured === "none") gitStackProvider = configured;
		else if (configured !== undefined) {
			warnings.push(
				`Invalid ${section.path}: "vcs.stackProvider" must be "github" or "none" with the git backend. Defaulting to "github".`,
			);
		}
	} else if (configured !== undefined) {
		warnings.push(
			`Ignoring "vcs.stackProvider" in ${section.path}: the ${backend} backend always uses the ${backend} stack provider.`,
		);
	}
	return backend === "git" ? { backend, gitStackProvider, warnings } : { backend, warnings };
}

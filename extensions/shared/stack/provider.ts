/** Provider mapping for stacked PR subsystems. */

import type { VcsBackendConfig } from "../vcs/config.ts";

export type StackProviderId = "jj" | "graphite" | "github";

export function stackProviderFor(config: VcsBackendConfig): StackProviderId | undefined {
	if (config.backend === "jj") return "jj";
	if (config.backend === "graphite") return "graphite";
	return config.gitStackProvider === "none" ? undefined : "github";
}

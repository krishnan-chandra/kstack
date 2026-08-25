/** Provider mapping for stacked PR subsystems. */

import type { VcsBackendId } from "../vcs/config.ts";

export type StackProviderId = "jj" | "graphite";

export function stackProviderFor(backend: VcsBackendId): StackProviderId | undefined {
	if (backend === "jj") return "jj";
	if (backend === "graphite") return "graphite";
	return undefined;
}

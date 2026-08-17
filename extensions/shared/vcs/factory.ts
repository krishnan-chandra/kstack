import type { ExecFn } from "../git-exec.ts";
import type { VcsBackend } from "./backend.ts";
import type { VcsBackendId } from "./config.ts";
import { GitBackend } from "./git-backend.ts";
import { GraphiteBackend } from "./graphite-backend.ts";
import { JjBackend } from "./jj-backend.ts";

/** Build the one configured backend used for every repository mutation in a run. */
export function createVcsBackend(id: VcsBackendId, exec: ExecFn): VcsBackend {
	switch (id) {
		case "git":
			return new GitBackend(exec);
		case "jj":
			return new JjBackend(exec);
		case "graphite":
			return new GraphiteBackend(exec);
		default: {
			const neverId: never = id;
			throw new Error(`Unsupported VCS backend: ${neverId}`);
		}
	}
}

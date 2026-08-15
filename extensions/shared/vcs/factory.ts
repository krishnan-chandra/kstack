import type { ExecFn } from "../git-exec.ts";
import type { VcsBackend } from "./backend.ts";
import type { VcsBackendId } from "./config.ts";
import { GitBackend } from "./git-backend.ts";
import { JjBackend } from "./jj-backend.ts";

/** Build the one configured backend used for every repository mutation in a run. */
export function createVcsBackend(id: VcsBackendId, exec: ExecFn): VcsBackend {
	return id === "jj" ? new JjBackend(exec) : new GitBackend(exec);
}

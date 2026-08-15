/** Stack-mode preflight: shared jj checks plus immutable trunk() resolution. */

import type { ExecFn } from "../shared/git-exec.ts";
import type { VcsResult } from "../shared/vcs/backend.ts";
import { preflightVcs } from "../shared/vcs/preflight.ts";

export type { ExecFn, ExecFnResult } from "../shared/git-exec.ts";

const SHA_RE = /^[0-9a-f]{40}$/;
const TRUNK_TEMPLATE = 'commit_id ++ "\\n"';

/** Verify the shared jj prerequisites and resolve trunk() to one Git-backed commit. */
export async function preflightStack(
	cwd: string,
	exec: ExecFn,
): Promise<VcsResult<{ trunkSha: string; workspaceRoot: string }>> {
	const backend = await preflightVcs(cwd, "jj", exec);
	if (!backend.ok) return backend;
	const trunkLog = await exec("jj", ["log", "-r", "trunk()", "--no-graph", "--no-pager", "-T", TRUNK_TEMPLATE], {
		cwd,
		timeout: 8_000,
	});
	if (trunkLog.code !== 0) {
		return {
			ok: false,
			error: `Could not resolve the trunk() revset. Ensure a remote main/master/trunk branch exists. jj said: ${trunkLog.stderr.trim() || trunkLog.stdout.trim()}`,
		};
	}
	const ids = trunkLog.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	if (ids.length === 0)
		return { ok: false, error: "trunk() resolved to no commits; ensure a remote main/master/trunk branch." };
	if (ids.length > 1) {
		return { ok: false, error: `trunk() resolved to ${ids.length} commits; a single immutable base is required.` };
	}
	const trunkSha = ids[0];
	if (!SHA_RE.test(trunkSha)) {
		return {
			ok: false,
			error: `trunk() resolved to a non-Git commit id "${trunkSha}"; a colocated Git-backed commit is required.`,
		};
	}
	return { ok: true, trunkSha, workspaceRoot: backend.workspaceRoot };
}

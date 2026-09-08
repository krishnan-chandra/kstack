/** Resolve a worktree-independent repository identity from the Git common directory.
 *
 * jj workspaces may not contain `.git`; when the backend is jj, `jj git root`
 * supplies the Git store first. Graphite is Git underneath. The key is the
 * SHA-256 of the canonical common directory, so every worktree and workspace
 * of one repository shares it.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import type { ExecFn, ExecFnResult } from "./git-exec.ts";

export type RepositoryIdentity = { ok: true; commonGitDir: string; key: string } | { ok: false; error: string };

export interface RepositoryIdentityDeps {
	backend?: "git" | "jj" | "graphite";
	realpath?: (path: string) => string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export async function resolveRepositoryIdentity(
	exec: ExecFn,
	cwd: string,
	deps: RepositoryIdentityDeps = {},
): Promise<RepositoryIdentity> {
	let common: ExecFnResult;
	try {
		const options = { cwd, timeout: deps.timeoutMs ?? 8_000, signal: deps.signal };
		const args = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
		if (deps.backend === "jj") {
			const root = await exec("jj", ["git", "root"], options);
			const gitDir = root.stdout.trim();
			if (root.code !== 0 || !gitDir) {
				return { ok: false, error: `jj git root: ${root.stderr.trim() || "no Git directory returned"}` };
			}
			args.unshift(`--git-dir=${gitDir}`);
		}
		common = await exec("git", args, options);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
	const commonGitDir = common.stdout.trim();
	if (common.code !== 0 || !commonGitDir) {
		return { ok: false, error: common.stderr.trim() || common.stdout.trim() || `exit ${common.code}` };
	}
	let canonical: string;
	try {
		canonical = (deps.realpath ?? realpathSync)(commonGitDir);
	} catch (error) {
		return { ok: false, error: `canonicalize: ${error instanceof Error ? error.message : String(error)}` };
	}
	return { ok: true, commonGitDir: canonical, key: createHash("sha256").update(canonical).digest("hex") };
}

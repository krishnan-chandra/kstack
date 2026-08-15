import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ExecFn, ExecFnResult } from "../git-exec.ts";
import type { VcsResult } from "./backend.ts";
import type { VcsBackendId } from "./config.ts";

interface PreflightDeps {
	exists?: (path: string) => boolean;
}

/** Enforce that mutation uses the configured backend before any model runs. */
export async function preflightVcs(
	cwd: string,
	backend: VcsBackendId,
	exec: ExecFn,
	deps: PreflightDeps = {},
): Promise<VcsResult<{ workspaceRoot: string }>> {
	if (backend === "jj") {
		return { ok: false, error: "The jj backend is configured but is not available in this K-Stack build." };
	}
	let root: ExecFnResult;
	try {
		root = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 8_000 });
	} catch (error) {
		return {
			ok: false,
			error: `The git backend requires Git, but the preflight command failed: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	const workspaceRoot = root.stdout.trim();
	if (root.code !== 0 || !workspaceRoot) {
		return { ok: false, error: "The git backend requires a Git working tree." };
	}
	if ((deps.exists ?? existsSync)(join(workspaceRoot, ".jj"))) {
		return {
			ok: false,
			error:
				"This repository is jj-managed but kstack.json selects the git backend. Run /setup-kstack to switch the backend to jj, or remove the jj workspace.",
		};
	}
	return { ok: true, workspaceRoot };
}

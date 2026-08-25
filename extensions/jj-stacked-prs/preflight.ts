import { dirname, join } from "node:path";
/** Stack-mode preflight: shared jj checks plus immutable trunk() resolution. */

import { fileURLToPath } from "node:url";
import type { ExecFn } from "../shared/git-exec.ts";
import { readPromptAsset } from "../shared/prompt-assets.ts";
import type { StackPreflight } from "../shared/stack/channel.ts";
import type { VcsResult } from "../shared/vcs/backend.ts";
import { preflightVcs } from "../shared/vcs/preflight.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(EXTENSION_DIR, "prompts");

const SHA_RE = /^[0-9a-f]{40}$/;
const TRUNK_TEMPLATE = 'commit_id ++ "\\n"';

function jjChildPolicy(): string {
	return readPromptAsset(PROMPTS_DIR, "jj-stack-local.md");
}

/** Verify the shared jj prerequisites and resolve trunk() to one Git-backed commit. */
export async function preflightJjStack(cwd: string, exec: ExecFn): Promise<VcsResult<StackPreflight>> {
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
	return {
		ok: true,
		workspaceRoot: backend.workspaceRoot,
		trunkRef: "trunk()",
		trunkSha,
		childPolicy: jjChildPolicy(),
	};
}

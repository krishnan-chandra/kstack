#!/usr/bin/env node
/** Read-only plan for one kstack-managed Git worktree. */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { BoundaryValue } from "../../../extensions/shared/validation.ts";
import { planManagedWorktree } from "../../../extensions/shared/vcs/worktree-plan.ts";
import { createSkillExec } from "./git-exec.ts";

const MISSING_TASK = "missing --task";
const MISSING_BASE =
	"Could not resolve a worktree base. Configure origin/HEAD, main, or master, or ensure HEAD names a commit.";
const COLLISION = "Could not allocate a unique managed worktree after 100 attempts.";

interface ParsedArgs {
	repo: string;
	task: string;
	root?: string;
}

function expandUserPath(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

function parseArgs(argv: string[]): ParsedArgs | { error: string } {
	let repo = ".";
	let task: string | undefined;
	let root: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--repo") {
			const value = argv[++i];
			if (!value) return { error: MISSING_TASK };
			repo = value;
			continue;
		}
		if (arg === "--task") {
			const value = argv[++i];
			if (!value) return { error: MISSING_TASK };
			task = value;
			continue;
		}
		if (arg === "--root") {
			const value = argv[++i];
			if (!value) return { error: MISSING_TASK };
			root = value;
			continue;
		}
		return { error: MISSING_TASK };
	}
	if (!task) return { error: MISSING_TASK };
	return { repo, task, root };
}

function exitCodeFor(error: string): number {
	if (error === MISSING_BASE) return 3;
	if (error === COLLISION) return 4;
	return 2;
}

function printError(error: string): void {
	process.stdout.write(`${JSON.stringify({ error }, null, 2)}\n`);
}

async function main(argv: string[]): Promise<number> {
	const parsed = parseArgs(argv);
	if ("error" in parsed) {
		printError(parsed.error);
		return 2;
	}
	const planned = await planManagedWorktree({
		exec: createSkillExec(),
		cwd: resolve(expandUserPath(parsed.repo)),
		task: parsed.task,
		managedRoot: parsed.root === undefined ? undefined : resolve(expandUserPath(parsed.root)),
	});
	if (!planned.ok) {
		printError(planned.error);
		return exitCodeFor(planned.error);
	}
	process.stdout.write(
		`${JSON.stringify(
			{
				base_ref: planned.plan.baseRef,
				base_sha: planned.plan.baseSha,
				branch: planned.plan.ref,
				common_git_dir: planned.commonGitDir,
				managed_root: planned.managedRoot,
				path: planned.plan.path,
				repository_id: planned.repositoryId,
				slug: planned.slug,
				source_repo_root: planned.plan.sourceRepoRoot,
			},
			null,
			2,
		)}\n`,
	);
	return 0;
}

function isMain(): boolean {
	const entry = process.argv[1];
	if (!entry) return false;
	return import.meta.url === pathToFileURL(entry).href;
}

if (isMain()) {
	main(process.argv.slice(2))
		.catch((cause: BoundaryValue) => {
			printError(cause instanceof Error ? cause.message : String(cause));
			return 1;
		})
		.then((code) => {
			process.exit(code);
		});
}

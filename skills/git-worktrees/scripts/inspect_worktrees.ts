#!/usr/bin/env node
/** Read-only, bounded inspection of kstack-managed Git worktrees. */

import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExecFn } from "../../../extensions/shared/git-exec.ts";
import { type BoundaryValue, isObject, isString } from "../../../extensions/shared/validation.ts";
import { resolveIsolationBase } from "../../../extensions/shared/vcs/worktree-plan.ts";
import { createSkillExec } from "./git-exec.ts";

export const OUTPUT_CAP = 256 * 1024;
const DEFAULT_ROOT = join(homedir(), ".pi", "kstack", "worktrees");
const DEFAULT_MAX = 200;
const DEFAULT_TIMEOUT_SECONDS = 10;

type PorcelainValue = string | true;
type PorcelainRecord = Record<string, PorcelainValue>;

interface InspectedWorktree {
	repository_id: string;
	path: string;
	common_git_dir: string | null;
	branch: string | null;
	detached: boolean;
	head: string | null;
	dirty: boolean;
	status_entries: number;
	untracked_entries: number;
	locked: PorcelainValue | false;
	prunable: PorcelainValue | false;
	base_ref: string | null;
	base_sha: string | null;
	head_reachable_from_base: boolean | null;
}

interface Orphan {
	path: string;
	reason: string;
}

interface ParsedArgs {
	root: string;
	maximum: number;
	timeoutSeconds: number;
}

interface EncodedInspectionOutput {
	body: string;
	overflow: boolean;
}

function expandUserPath(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return join(homedir(), value.slice(2));
	return value;
}

function printError(error: string): void {
	process.stdout.write(`${JSON.stringify({ error })}\n`);
}

function parseArgs(argv: string[]): ParsedArgs | { error: string } {
	let root = DEFAULT_ROOT;
	let maximum = DEFAULT_MAX;
	let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = argv[++i];
		if (value === undefined) return { error: `missing value for ${arg}` };
		if (arg === "--root") {
			root = value;
			continue;
		}
		if (arg === "--max") {
			const parsed = Number(value);
			if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
				return { error: "--max must be between 1 and 1000" };
			}
			maximum = parsed;
			continue;
		}
		if (arg === "--timeout") {
			const parsed = Number(value);
			if (!Number.isInteger(parsed) || parsed < 1 || parsed > 60) {
				return { error: "--timeout must be between 1 and 60" };
			}
			timeoutSeconds = parsed;
			continue;
		}
		return { error: `unknown flag ${arg}` };
	}
	return { root, maximum, timeoutSeconds };
}

export function parseWorktreePorcelainZ(data: Buffer): PorcelainRecord[] {
	const records: PorcelainRecord[] = [];
	let current: PorcelainRecord = {};
	for (const raw of data.toString("utf8").split("\0")) {
		if (!raw) {
			if (Object.keys(current).length > 0) {
				records.push(current);
				current = {};
			}
			continue;
		}
		const space = raw.indexOf(" ");
		const key = space === -1 ? raw : raw.slice(0, space);
		const value = space === -1 ? "" : raw.slice(space + 1);
		if (key === "worktree" && Object.keys(current).length > 0) {
			records.push(current);
			current = {};
		}
		if (key === "bare" || key === "detached") {
			current[key] = true;
		} else if (key === "locked" || key === "prunable") {
			current[key] = value || true;
		} else {
			current[key] = value;
		}
	}
	if (Object.keys(current).length > 0) records.push(current);
	return records;
}

function sortKeys(value: BoundaryValue): BoundaryValue {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (!isObject(value)) return value;
	return Object.fromEntries(
		Object.keys(value)
			.sort()
			.map((key) => [key, sortKeys(Object.getOwnPropertyDescriptor(value, key)?.value)]),
	);
}

export function encodeInspectionOutput(payload: {
	managed_root: string;
	candidate_count: number;
	worktrees: BoundaryValue[];
	orphans: BoundaryValue[];
	truncated: boolean;
}): EncodedInspectionOutput {
	const encoded = `${JSON.stringify(sortKeys(payload), null, 2)}\n`;
	if (Buffer.byteLength(encoded, "utf8") > OUTPUT_CAP) {
		return {
			overflow: true,
			body: `${JSON.stringify({
				candidate_count: payload.candidate_count,
				error: `inspection output exceeded ${OUTPUT_CAP} bytes`,
				managed_root: payload.managed_root,
				truncated: true,
			})}\n`,
		};
	}
	return { overflow: false, body: encoded };
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function listCandidates(root: string): string[] {
	const candidates: string[] = [];
	if (!isDirectory(root)) return candidates;
	for (const repoName of readdirSync(root).sort()) {
		const repoDir = join(root, repoName);
		if (!isDirectory(repoDir)) continue;
		for (const childName of readdirSync(repoDir).sort()) {
			const child = join(repoDir, childName);
			try {
				const childStat = lstatSync(child);
				if (childStat.isDirectory() || childStat.isSymbolicLink()) candidates.push(child);
			} catch {
				// Skip unreadable or vanished children.
			}
		}
	}
	return candidates;
}

function staysInsideRoot(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

async function inspectCandidate(exec: ExecFn, path: string, timeoutMs: number): Promise<InspectedWorktree | undefined> {
	const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: path, timeout: timeoutMs });
	if (top.code !== 0) return undefined;
	const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
		cwd: path,
		timeout: timeoutMs,
	});
	const branch = await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
		cwd: path,
		timeout: timeoutMs,
	});
	const head = await exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: path, timeout: timeoutMs });
	const status = await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
		cwd: path,
		timeout: timeoutMs,
	});
	const listing = await exec("git", ["worktree", "list", "--porcelain", "-z"], {
		cwd: path,
		timeout: timeoutMs,
	});
	const canonical = realpathSync(path);
	const authoritative =
		parseWorktreePorcelainZ(Buffer.from(listing.stdout)).find((record) => {
			const worktree = record.worktree;
			if (!isString(worktree) || !worktree) return false;
			try {
				return realpathSync(worktree) === canonical;
			} catch {
				return false;
			}
		}) ?? {};
	const entries = status.stdout.split("\0").filter(Boolean);
	const untracked = entries.filter((entry) => entry.startsWith("??")).length;
	const base = await resolveIsolationBase(exec, path);
	let reachable: boolean | null = null;
	if (base) {
		const merged = await exec("git", ["merge-base", "--is-ancestor", "HEAD", base.ref], {
			cwd: path,
			timeout: timeoutMs,
		});
		reachable = merged.code === 0;
	}
	let commonGitDir: string | null = null;
	if (common.code === 0 && common.stdout.trim()) {
		try {
			commonGitDir = realpathSync(common.stdout.trim());
		} catch {
			commonGitDir = null;
		}
	}
	return {
		repository_id: path.split(/[/\\]/).at(-2) ?? "",
		path: canonical,
		common_git_dir: commonGitDir,
		branch: branch.code === 0 ? branch.stdout.trim() || null : null,
		detached: branch.code !== 0,
		head: head.code === 0 ? head.stdout.trim() || null : null,
		dirty: entries.length > 0,
		status_entries: entries.length,
		untracked_entries: untracked,
		locked: authoritative.locked ?? false,
		prunable: authoritative.prunable ?? false,
		base_ref: base?.ref ?? null,
		base_sha: base?.sha ?? null,
		head_reachable_from_base: reachable,
	};
}

async function main(argv: string[]): Promise<number> {
	const parsed = parseArgs(argv);
	if ("error" in parsed) {
		printError(parsed.error);
		return 2;
	}
	const resolvedRoot = resolve(expandUserPath(parsed.root));
	const root = existsSync(resolvedRoot) ? realpathSync(resolvedRoot) : resolvedRoot;
	const candidates = listCandidates(root);
	const truncated = candidates.length > parsed.maximum;
	const worktrees: InspectedWorktree[] = [];
	const orphans: Orphan[] = [];
	const exec = createSkillExec();
	const timeoutMs = parsed.timeoutSeconds * 1000;
	for (const candidate of candidates.slice(0, parsed.maximum)) {
		if (lstatSync(candidate).isSymbolicLink()) {
			orphans.push({ path: candidate, reason: "symlink entries are not treated as managed worktrees" });
			continue;
		}
		try {
			if (!staysInsideRoot(realpathSync(candidate), root)) {
				orphans.push({ path: candidate, reason: "path escapes the managed root" });
				continue;
			}
		} catch (error) {
			orphans.push({
				path: candidate,
				reason: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		let item: InspectedWorktree | undefined;
		try {
			item = await inspectCandidate(exec, candidate, timeoutMs);
		} catch (error) {
			orphans.push({
				path: candidate,
				reason: error instanceof Error ? error.message : String(error),
			});
			continue;
		}
		if (!item) {
			orphans.push({ path: candidate, reason: "not a resolvable Git working tree" });
		} else {
			worktrees.push(item);
		}
	}
	const encoded = encodeInspectionOutput({
		managed_root: root,
		worktrees,
		orphans,
		truncated,
		candidate_count: candidates.length,
	});
	process.stdout.write(encoded.body);
	return encoded.overflow ? 1 : 0;
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

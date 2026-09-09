#!/usr/bin/env node
/** Read-only, bounded inspection of kstack-managed Git worktrees. */

import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExecFn, ExecFnResult } from "../../../extensions/shared/git-exec.ts";
import { type BoundaryValue, isObject } from "../../../extensions/shared/validation.ts";
import { parseGitStatus } from "../../../extensions/shared/vcs/git-status.ts";
import { parseWorktreeInventory } from "../../../extensions/shared/vcs/worktree-inventory.ts";
import { resolveIsolationBase } from "../../../extensions/shared/vcs/worktree-plan.ts";
import { createSkillExec } from "./git-exec.ts";

export const OUTPUT_CAP = 256 * 1024;
const DEFAULT_ROOT = join(homedir(), ".pi", "kstack", "worktrees");
const DEFAULT_MAX = 200;
const DEFAULT_TIMEOUT_SECONDS = 10;
const INSPECTION_REASON_CAP = 512;
const OBJECT_ID_RE = /^[0-9a-f]{40,64}$/;

interface InspectedWorktree {
	repository_id: string;
	path: string;
	common_git_dir: string;
	branch: string | null;
	detached: boolean;
	head: string;
	dirty: boolean;
	status_entries: number;
	untracked_entries: number;
	locked: false | true | string;
	prunable: false | true | string;
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

function errorMessage(error: BoundaryValue): string {
	return error instanceof Error ? error.message : String(error);
}

function limitInspectionReason(reason: string): string {
	const suffix = "...";
	const encoded = Buffer.from(reason.replaceAll("\0", "\\0"), "utf8");
	if (encoded.byteLength <= INSPECTION_REASON_CAP) return encoded.toString("utf8");
	let prefix = encoded.subarray(0, INSPECTION_REASON_CAP - Buffer.byteLength(suffix)).toString("utf8");
	if (prefix.endsWith("�")) prefix = prefix.slice(0, -1);
	return `${prefix}${suffix}`;
}

function inspectionFailureReason(error: BoundaryValue): string {
	return limitInspectionReason(`inspection failed: ${errorMessage(error)}`);
}

function commandFailure(command: string, result: ExecFnResult): Error {
	const diagnostic = result.stderr.trim() || result.stdout.trim();
	const detail = diagnostic ? `: ${diagnostic}` : "";
	return new Error(`${command} exited ${result.code}${detail}`);
}

function requireCommandSuccess(command: string, result: ExecFnResult): void {
	if (result.code !== 0) throw commandFailure(command, result);
}

function requireCommandOutput(command: string, result: ExecFnResult): string {
	requireCommandSuccess(command, result);
	const value = result.stdout.trim();
	if (!value) throw new Error(`${command} returned no usable output`);
	return value;
}

function canonicalizeFact(command: string, path: string): string {
	try {
		return realpathSync(path);
	} catch (error) {
		throw new Error(`${command} returned an unusable path ${JSON.stringify(path)}: ${errorMessage(error)}`);
	}
}

async function inspectCandidate(exec: ExecFn, path: string, timeoutMs: number): Promise<InspectedWorktree> {
	const canonical = realpathSync(path);
	const topCommand = "git rev-parse --show-toplevel";
	const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: path, timeout: timeoutMs });
	const canonicalTop = canonicalizeFact(topCommand, requireCommandOutput(topCommand, top));
	if (canonicalTop !== canonical) {
		throw new Error(
			`${topCommand} returned a toplevel that does not match the candidate: ${JSON.stringify(canonicalTop)}`,
		);
	}

	const commonCommand = "git rev-parse --path-format=absolute --git-common-dir";
	const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
		cwd: path,
		timeout: timeoutMs,
	});
	const commonPath = requireCommandOutput(commonCommand, common);
	if (!isAbsolute(commonPath)) throw new Error(`${commonCommand} returned a non-absolute path`);
	const commonGitDir = canonicalizeFact(commonCommand, commonPath);
	if (!isDirectory(commonGitDir)) throw new Error(`${commonCommand} did not identify a directory`);

	const branchCommand = "git symbolic-ref --quiet --short HEAD";
	const branchResult = await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
		cwd: path,
		timeout: timeoutMs,
	});
	let branch: string | null;
	if (branchResult.code === 0) {
		branch = requireCommandOutput(branchCommand, branchResult);
	} else if (branchResult.code === 1) {
		branch = null;
	} else {
		throw commandFailure(branchCommand, branchResult);
	}

	const headCommand = "git rev-parse --verify HEAD";
	const headResult = await exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: path, timeout: timeoutMs });
	const head = requireCommandOutput(headCommand, headResult);
	if (!OBJECT_ID_RE.test(head)) throw new Error(`${headCommand} returned an invalid object ID`);

	const statusCommand = "git status --porcelain=v1 -z --untracked-files=all";
	const status = await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
		cwd: path,
		timeout: timeoutMs,
	});
	requireCommandSuccess(statusCommand, status);
	const entries = parseGitStatus(status.stdout);
	const untracked = entries.filter((entry) => entry.xy === "??").length;

	const listingCommand = "git worktree list --porcelain -z";
	const listing = await exec("git", ["worktree", "list", "--porcelain", "-z"], {
		cwd: path,
		timeout: timeoutMs,
	});
	requireCommandSuccess(listingCommand, listing);
	const inventory = parseWorktreeInventory(listing.stdout);
	if (!inventory.ok) throw new Error(`${listingCommand}: ${inventory.error}`);
	const authoritativeMatches = inventory.value.filter((record) => {
		try {
			return realpathSync(record.path) === canonical;
		} catch {
			return false;
		}
	});
	if (authoritativeMatches.length === 0) {
		throw new Error(`${listingCommand} is missing an authoritative match for the candidate`);
	}
	if (authoritativeMatches.length > 1) {
		throw new Error(`${listingCommand} returned an ambiguous authoritative match for the candidate`);
	}
	const authoritative = authoritativeMatches[0];
	if (!authoritative) throw new Error(`${listingCommand} did not return an authoritative record`);

	const base = await resolveIsolationBase(exec, path);
	let reachable: boolean | null = null;
	if (base) {
		const mergeBaseCommand = `git merge-base --is-ancestor HEAD ${base.ref}`;
		const merged = await exec("git", ["merge-base", "--is-ancestor", "HEAD", base.ref], {
			cwd: path,
			timeout: timeoutMs,
		});
		if (merged.code === 0) {
			reachable = true;
		} else if (merged.code === 1) {
			reachable = false;
		} else {
			throw commandFailure(mergeBaseCommand, merged);
		}
	}
	return {
		repository_id: path.split(/[/\\]/).at(-2) ?? "",
		path: canonical,
		common_git_dir: commonGitDir,
		branch,
		detached: branch === null,
		head,
		dirty: entries.length > 0,
		status_entries: entries.length,
		untracked_entries: untracked,
		locked: authoritative.locked,
		prunable: authoritative.prunable,
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
		try {
			if (lstatSync(candidate).isSymbolicLink()) {
				orphans.push({ path: candidate, reason: "symlink entries are not treated as managed worktrees" });
				continue;
			}
		} catch (error) {
			orphans.push({ path: candidate, reason: inspectionFailureReason(error) });
			continue;
		}
		try {
			if (!staysInsideRoot(realpathSync(candidate), root)) {
				orphans.push({ path: candidate, reason: "path escapes the managed root" });
				continue;
			}
		} catch (error) {
			orphans.push({ path: candidate, reason: inspectionFailureReason(error) });
			continue;
		}
		try {
			worktrees.push(await inspectCandidate(exec, candidate, timeoutMs));
		} catch (error) {
			orphans.push({ path: candidate, reason: inspectionFailureReason(error) });
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
			printError(errorMessage(cause));
			return 1;
		})
		.then((code) => {
			process.exit(code);
		});
}

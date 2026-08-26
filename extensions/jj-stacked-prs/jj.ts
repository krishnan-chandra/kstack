import { type BoundaryValue, isBoolean, isObject, isString, type JsonObject } from "../shared/validation.ts";

/** Validated jj and read-only Git adapter. */

import { parseGithubUrl, redactUrl } from "../shared/github.ts";
import { preflightVcs } from "../shared/vcs/preflight.ts";
import type { CommandResult, ProcessRunner } from "./process.ts";
import { parseConcatenatedJson } from "./stack.ts";
import {
	type BookmarkTarget,
	DEFAULT_TIMEOUT_MS,
	MAX_NAME_CHARS,
	MAX_REVSET_CHARS,
	MAX_SUBJECT_CHARS,
	type RemoteInfo,
	type StackCommit,
} from "./types.ts";

const BOOKMARK_TEMPLATE = 'if(self.remote(), "", self.name() ++ "\\t" ++ self.normal_target().commit_id() ++ "\\n")';
const REMOTE_BOOKMARK_TEMPLATE =
	'if(self.remote(), self.name() ++ "\\t" ++ self.normal_target().commit_id() ++ "\\n", "")';
const STACK_TEMPLATE =
	'"" ++ "{\\"change_id\\":\\"" ++ change_id ++ "\\",\\"commit_id\\":\\"" ++ commit_id ++ "\\",\\"subject\\":" ++ description.first_line().escape_json() ++ ",\\"empty\\":" ++ if(empty, "true", "false") ++ ",\\"conflict\\":" ++ if(conflict, "true", "false") ++ ",\\"divergent\\":" ++ if(divergent, "true", "false") ++ ",\\"merge\\":" ++ if(parents.len() > 1, "true", "false") ++ ",\\"bookmarks\\":" ++ json(local_bookmarks.map(|b| b.name())) ++ ",\\"remote_bookmarks\\":" ++ json(remote_bookmarks.map(|b| b.name())) ++ ",\\"parents\\":" ++ json(parents.map(|c| c.commit_id())) ++ "}"';
const COMMIT_ID_TEMPLATE = 'commit_id ++ "\\n"';
const CHANGE_ID_TEMPLATE = 'change_id ++ "\\n"';
const OPERATION_ID_TEMPLATE = 'self.id().short() ++ "\\n"';
const WORKING_COPY_TEMPLATE =
	'commit_id ++ "\\t" ++ if(empty, "true", "false") ++ "\\t" ++ if(local_bookmarks.len() > 0, "true", "false") ++ "\\t" ++ json(parents.map(|c| c.commit_id())) ++ "\\n"';

export class JjError extends Error {
	readonly kind: "failed" | "indeterminate";
	constructor(message: string, kind: "failed" | "indeterminate" = "failed") {
		super(message);
		this.kind = kind;
	}
}

interface WorkingCopyStatus {
	commitId: string;
	empty: boolean;
	bookmarked: boolean;
	parentCommitIds: readonly string[];
}

export interface JjAdapter {
	preflight(cwd: string, signal?: AbortSignal): Promise<{ workspaceRoot: string; jjVersion: string }>;
	resolveRevset(cwd: string, revset: string, signal?: AbortSignal): Promise<string>;
	workingCopyChangeId(cwd: string, signal?: AbortSignal): Promise<string | undefined>;
	workingCopyStatus(cwd: string, signal?: AbortSignal): Promise<WorkingCopyStatus | undefined>;
	rebaseWorkingCopy(cwd: string, commitId: string, signal?: AbortSignal): Promise<void>;
	listLocalBookmarks(cwd: string, signal?: AbortSignal): Promise<BookmarkTarget[]>;
	listRemoteBookmarks(cwd: string, remote: string, signal?: AbortSignal): Promise<BookmarkTarget[]>;
	fetchStack(cwd: string, revset: string, signal?: AbortSignal): Promise<StackCommit[]>;
	listRemotes(cwd: string, signal?: AbortSignal): Promise<RemoteInfo[]>;
	getRemote(cwd: string, name: string, signal?: AbortSignal): Promise<RemoteInfo>;
	currentOperationId(cwd: string, signal?: AbortSignal): Promise<string>;
	pushBookmark(cwd: string, remote: string, bookmark: string, signal?: AbortSignal): Promise<void>;
	fetchRemote(cwd: string, remote: string, signal?: AbortSignal): Promise<void>;
	rebaseStack(cwd: string, top: string, trunk: string, signal?: AbortSignal): Promise<void>;
	abandonRange(cwd: string, trunk: string, mergedBookmark: string, signal?: AbortSignal): Promise<void>;
	isAncestor(cwd: string, ancestor: string, descendant: string, signal?: AbortSignal): Promise<boolean>;
}

export function bookmarkRevset(bookmark: string): string {
	assertBoundedName(bookmark, "bookmark", MAX_NAME_CHARS);
	return `bookmarks(exact:${JSON.stringify(bookmark)})`;
}

export function createJjAdapter(run: ProcessRunner): JjAdapter {
	const exec = async (
		command: string,
		args: string[],
		options: { cwd: string; timeout?: number; signal?: AbortSignal },
	) => {
		const result = await run([command, ...args], {
			cwd: options.cwd,
			timeoutMs: options.timeout ?? DEFAULT_TIMEOUT_MS,
			signal: options.signal,
		});
		if (result.kind === "ok" || result.kind === "nonzero") {
			return { code: result.code, stdout: result.stdout, stderr: result.stderr };
		}
		throw toJjError(result, command);
	};

	return {
		async preflight(cwd, signal) {
			const version = await runJj(run, ["--version"], { cwd, signal });
			const preflight = await preflightVcs(cwd, "jj", exec);
			if (!preflight.ok) throw new JjError(preflight.error);
			return { workspaceRoot: preflight.workspaceRoot, jjVersion: version.stdout.trim() };
		},
		async resolveRevset(cwd, revset, signal) {
			assertBoundedName(revset, "revset", MAX_REVSET_CHARS);
			const result = await runJj(run, ["log", "-r", revset, "--no-graph", "--no-pager", "-T", COMMIT_ID_TEMPLATE], {
				cwd,
				signal,
			});
			const ids = nonemptyLines(result.stdout);
			if (ids.length !== 1)
				throw new JjError(`Could not resolve revset ${JSON.stringify(revset)} to exactly one commit.`);
			return ids[0];
		},
		async workingCopyChangeId(cwd, signal) {
			try {
				const result = await runJj(run, ["log", "-r", "@", "--no-graph", "--no-pager", "-T", CHANGE_ID_TEMPLATE], {
					cwd,
					signal,
				});
				const ids = nonemptyLines(result.stdout);
				return ids.length === 1 ? ids[0] : undefined;
			} catch {
				return undefined;
			}
		},
		async workingCopyStatus(cwd, signal) {
			const result = await runJj(run, ["log", "-r", "@", "--no-graph", "--no-pager", "-T", WORKING_COPY_TEMPLATE], {
				cwd,
				signal,
			});
			const rows = nonemptyLines(result.stdout);
			if (rows.length !== 1) return undefined;
			const [commitId, empty, bookmarked, rawParents, ...extra] = rows[0].split("\t");
			const isFlag = (value: string | undefined): value is "true" | "false" => value === "true" || value === "false";
			if (!commitId || !isFlag(empty) || !isFlag(bookmarked) || !rawParents || extra.length > 0) return undefined;
			let parents: BoundaryValue;
			try {
				parents = JSON.parse(rawParents);
			} catch {
				return undefined;
			}
			if (!Array.isArray(parents) || !parents.every((parent): parent is string => isString(parent))) {
				return undefined;
			}
			return {
				commitId,
				empty: empty === "true",
				bookmarked: bookmarked === "true",
				parentCommitIds: parents,
			};
		},
		async rebaseWorkingCopy(cwd, commitId, signal) {
			assertBoundedName(commitId, "commit id", MAX_REVSET_CHARS);
			await runJj(run, ["rebase", "-r", "@", "-d", commitId], { cwd, signal });
		},
		async listLocalBookmarks(cwd, signal) {
			const result = await runJj(run, ["bookmark", "list", "--no-pager", "-T", BOOKMARK_TEMPLATE], { cwd, signal });
			return parseBookmarkLines(result.stdout);
		},
		async listRemoteBookmarks(cwd, remote, signal) {
			assertBoundedName(remote, "remote", MAX_NAME_CHARS);
			const result = await runJj(
				run,
				["bookmark", "list", "--no-pager", "--remote", remote, "-T", REMOTE_BOOKMARK_TEMPLATE],
				{ cwd, signal },
			);
			return parseBookmarkLines(result.stdout);
		},
		async fetchStack(cwd, revset, signal) {
			assertBoundedName(revset, "revset", MAX_REVSET_CHARS);
			const result = await runJj(
				run,
				["log", "-r", revset, "--reversed", "--no-graph", "--no-pager", "-T", STACK_TEMPLATE],
				{ cwd, signal },
			);
			return parseStackCommits(result.stdout);
		},
		async listRemotes(cwd, signal) {
			const names = await listRemoteNames(run, cwd, signal);
			const remotes: RemoteInfo[] = [];
			for (const name of names) remotes.push(await readRemote(run, cwd, name, signal));
			return remotes;
		},
		async getRemote(cwd, name, signal) {
			assertBoundedName(name, "remote", MAX_NAME_CHARS);
			const remotes = await listRemoteNames(run, cwd, signal);
			if (!remotes.includes(name)) {
				throw new JjError(
					`Remote ${JSON.stringify(name)} does not exist. Available: ${remotes.join(", ") || "(none)"}.`,
				);
			}
			return readRemote(run, cwd, name, signal);
		},
		async currentOperationId(cwd, signal) {
			const result = await runJj(run, ["op", "log", "--limit", "1", "--no-graph", "-T", OPERATION_ID_TEMPLATE], {
				cwd,
				signal,
			});
			const ids = nonemptyLines(result.stdout);
			if (ids.length !== 1) throw new JjError("Could not read the current jj operation id.");
			return ids[0];
		},
		async pushBookmark(cwd, remote, bookmark, signal) {
			assertBoundedName(remote, "remote", MAX_NAME_CHARS);
			assertBoundedName(bookmark, "bookmark", MAX_NAME_CHARS);
			await runJj(run, ["git", "push", "--remote", remote, "--bookmark", bookmark], { cwd, signal });
		},
		async fetchRemote(cwd, remote, signal) {
			assertBoundedName(remote, "remote", MAX_NAME_CHARS);
			await runJj(run, ["git", "fetch", "--remote", remote], { cwd, signal });
		},
		async rebaseStack(cwd, top, trunk, signal) {
			assertBoundedName(trunk, "revset", MAX_REVSET_CHARS);
			await runJj(run, ["rebase", "-b", bookmarkRevset(top), "-o", trunk], { cwd, signal });
		},
		async abandonRange(cwd, trunk, mergedBookmark, signal) {
			assertBoundedName(trunk, "revset", MAX_REVSET_CHARS);
			await runJj(run, ["abandon", `(${trunk})..${bookmarkRevset(mergedBookmark)}`], { cwd, signal });
		},
		async isAncestor(cwd, ancestor, descendant, signal) {
			assertBoundedName(ancestor, "revset", MAX_REVSET_CHARS);
			assertBoundedName(descendant, "revset", MAX_REVSET_CHARS);
			const result = await runJj(
				run,
				["log", "-r", `${ancestor} & ::${descendant}`, "--no-graph", "--no-pager", "-T", COMMIT_ID_TEMPLATE],
				{ cwd, signal },
			);
			return nonemptyLines(result.stdout).length > 0;
		},
	};
}

export function parseBookmarkLines(text: string): BookmarkTarget[] {
	const bookmarks: BookmarkTarget[] = [];
	const seen = new Set<string>();
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		const parts = line.split("\t");
		if (parts.length !== 2 || !parts[0] || !parts[1]) {
			throw new JjError(`Malformed bookmark list output: ${JSON.stringify(line)}`);
		}
		const key = `${parts[0]}\t${parts[1]}`;
		if (seen.has(key)) throw new JjError(`Duplicate bookmark row: ${JSON.stringify(line)}`);
		seen.add(key);
		bookmarks.push({ name: parts[0], commitId: parts[1] });
	}
	return bookmarks;
}

export function parseStackCommits(text: string): StackCommit[] {
	const commits: StackCommit[] = [];
	const seen = new Set<string>();
	for (const value of parseConcatenatedJson(text)) {
		const commit = parseStackCommit(value);
		if (seen.has(commit.changeId)) throw new JjError(`Duplicate change id in stack output: ${commit.changeId}`);
		seen.add(commit.changeId);
		commits.push(commit);
	}
	return commits;
}

function parseStackCommit(value: BoundaryValue): StackCommit {
	if (!isObject(value) || value === null) throw new JjError("Malformed stack JSON: expected an object.");
	const record =
		/* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ value as JsonObject;
	const changeId = requiredString(record.change_id, "change_id");
	const commitId = requiredString(record.commit_id, "commit_id");
	const subject = optionalString(record.subject, "subject") ?? "";
	if (subject.length > MAX_SUBJECT_CHARS) throw new JjError(`Change ${changeId} has an oversized subject.`);
	return {
		changeId,
		commitId,
		subject,
		bookmarks: stringArray(record.bookmarks, "bookmarks"),
		remoteBookmarks: stringArray(record.remote_bookmarks, "remote_bookmarks"),
		parentCommitIds: stringArray(record.parents, "parents"),
		empty: requiredBoolean(record.empty, "empty"),
		conflict: requiredBoolean(record.conflict, "conflict"),
		divergent: requiredBoolean(record.divergent, "divergent"),
		merge: requiredBoolean(record.merge, "merge"),
		workingCopy: false,
	};
}

async function listRemoteNames(run: ProcessRunner, cwd: string, signal?: AbortSignal): Promise<string[]> {
	const result = await runGit(run, ["remote"], { cwd, signal });
	return nonemptyLines(result.stdout);
}

async function readRemote(run: ProcessRunner, cwd: string, name: string, signal?: AbortSignal): Promise<RemoteInfo> {
	const result = await runGit(run, ["remote", "get-url", name], { cwd, signal });
	const url = result.stdout.trim();
	if (!url) throw new JjError(`Remote ${JSON.stringify(name)} has an empty URL.`);
	return {
		name,
		url,
		redactedUrl: redactUrl(url),
		github: parseGithubUrl(url),
	};
}

async function runJj(
	run: ProcessRunner,
	args: string[],
	options: { cwd: string; signal?: AbortSignal },
): Promise<{ stdout: string }> {
	const result = await run(["jj", ...args], {
		cwd: options.cwd,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		signal: options.signal,
	});
	if (result.kind !== "ok") throw toJjError(result, "jj");
	if (result.code !== 0) {
		throw new JjError(`jj ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`);
	}
	return { stdout: result.stdout };
}

async function runGit(
	run: ProcessRunner,
	args: string[],
	options: { cwd: string; signal?: AbortSignal },
): Promise<{ stdout: string }> {
	const result = await run(["git", ...args], {
		cwd: options.cwd,
		timeoutMs: DEFAULT_TIMEOUT_MS,
		signal: options.signal,
	});
	if (result.kind !== "ok") throw toJjError(result, "git");
	if (result.code !== 0) {
		throw new JjError(
			`git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
		);
	}
	return { stdout: result.stdout };
}

function toJjError(result: Exclude<CommandResult, { kind: "ok" }>, command: string): JjError {
	if (result.kind === "timeout" || result.kind === "cancelled" || result.kind === "uncertain") {
		return new JjError(`${command} ended without a conclusive result (${result.kind}).`, "indeterminate");
	}
	if (result.kind === "nonzero") {
		return new JjError(`${command} failed: ${result.message}`);
	}
	return new JjError(`${command} failed: ${result.message}`);
}

function nonemptyLines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function requiredString(value: BoundaryValue, field: string): string {
	if (!isString(value) || value.length === 0) throw new JjError(`Malformed stack JSON: missing ${field}.`);
	return value;
}

function optionalString(value: BoundaryValue, field: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isString(value)) throw new JjError(`Malformed stack JSON: ${field} must be a string.`);
	return value;
}

function requiredBoolean(value: BoundaryValue, field: string): boolean {
	if (!isBoolean(value)) throw new JjError(`Malformed stack JSON: ${field} must be a boolean.`);
	return value;
}

function stringArray(value: BoundaryValue, field: string): string[] {
	if (!Array.isArray(value) || value.some((item) => !isString(item))) {
		throw new JjError(`Malformed stack JSON: ${field} must be a string array.`);
	}
	return /* SAFETY: The owner contract validates or supplies this boundary value before domain use. */ value as string[];
}

function assertBoundedName(value: string, label: string, max: number): void {
	if (!value || value.length > max || /[\0\n\r]/.test(value)) {
		throw new JjError(`Invalid ${label}: ${JSON.stringify(value)}.`);
	}
}

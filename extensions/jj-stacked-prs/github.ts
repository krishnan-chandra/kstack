/** Validated gh adapter and navigation-comment codec. */

import type { CommandFailure, ProcessRunner } from "./process.ts";
import {
	type GitHubRepository,
	KSTACK_COMMENT_MARKER,
	KSTACK_COMMENT_SCHEMA_VERSION,
	MAX_NAVIGATION_COMMENT_BYTES,
	MAX_NAVIGATION_ENTRIES,
	type NavigationEntry,
	type NavigationStatus,
	type OpenPullRequest,
} from "./types.ts";

const GITHUB_URL_PATTERN =
	/^(?:https:\/\/(?:[^@]+@)?github\.com\/|git@github\.com:|ssh:\/\/(?:[^@]+@)?github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/;
const DATA_MARKER_PATTERN = /<!-- kstack-stack-data-v1: ([A-Za-z0-9_-]+) -->/;
const VALID_NAVIGATION_STATUSES = new Set<NavigationStatus>(["open", "draft", "merged", "closed", "unknown"]);
const GH_TIMEOUT_MS = 30_000;

export interface GitHubComment {
	id: number;
	body: string;
	user: string | undefined;
}

export function parseGithubUrl(url: string): GitHubRepository | undefined {
	const match = GITHUB_URL_PATTERN.exec(url.trim());
	if (!match) return undefined;
	return { owner: match[1], repo: match[2] };
}

export function redactUrl(url: string): string {
	return url.replace(/(https?:\/\/)[^@]+@/g, "$1***@");
}

function normalizeNavigationStatus(value: string): NavigationStatus {
	const status = value.toLowerCase();
	return VALID_NAVIGATION_STATUSES.has(status as NavigationStatus) ? (status as NavigationStatus) : "unknown";
}

export function buildNavigationComment(entries: readonly NavigationEntry[], defaultBranch: string): string {
	if (entries.length > MAX_NAVIGATION_ENTRIES) {
		throw new Error(`Navigation comment has ${entries.length} entries; maximum is ${MAX_NAVIGATION_ENTRIES}.`);
	}
	const dataPayload = encodeNavigationEntries(entries);
	const lines = [
		KSTACK_COMMENT_MARKER,
		`<!-- kstack-stack-schema-v${KSTACK_COMMENT_SCHEMA_VERSION} -->`,
		`<!-- kstack-stack-data-v1: ${dataPayload} -->`,
		"",
		"## Stack navigation (kstack)",
		"",
		"| PR | Bookmark | Base | Status |",
		"|---|---|---|---|",
	];
	for (const entry of entries) {
		const prRef = entry.prNumber ? `#${entry.prNumber}` : "—";
		const bookmark = entry.bookmark ? markdownCode(entry.bookmark) : "—";
		const base = markdownCode(entry.base || defaultBranch);
		lines.push(`| ${prRef} | ${bookmark} | ${base} | ${capitalize(entry.status)} |`);
	}
	lines.push("", "_Navigated by kstack. Update with `/jj-stack publish`._");
	const body = lines.join("\n");
	if (Buffer.byteLength(body, "utf8") > MAX_NAVIGATION_COMMENT_BYTES) {
		throw new Error(`Navigation comment exceeds ${MAX_NAVIGATION_COMMENT_BYTES} bytes.`);
	}
	return body;
}

export function parseNavigationCommentEntries(body: string): NavigationEntry[] {
	if (!body.includes(KSTACK_COMMENT_MARKER)) return [];
	const dataMatch = DATA_MARKER_PATTERN.exec(body);
	if (dataMatch) {
		const encoded = dataMatch[1];
		try {
			const padding = "=".repeat((4 - (encoded.length % 4)) % 4);
			const parsed: unknown = JSON.parse(Buffer.from(encoded + padding, "base64url").toString("utf8"));
			if (Array.isArray(parsed) && parsed.length <= MAX_NAVIGATION_ENTRIES) {
				const entries = parsed.map(parseNavigationItem);
				if (entries.every((entry) => entry !== undefined)) return entries.filter((entry) => entry !== undefined);
			}
		} catch {
			/* fall back to the Markdown table */
		}
	}

	const entries: NavigationEntry[] = [];
	for (const line of body.split("\n")) {
		const stripped = line.trim();
		if (!stripped.startsWith("|")) continue;
		const cells = stripped
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split("|")
			.map((cell) => cell.trim());
		if (cells.length !== 3 && cells.length !== 4) continue;
		if (cells[0].toLowerCase() === "pr") continue;
		if (cells.every((cell) => /^[-:]+$/.test(cell))) continue;
		const prMatch = /#(\d+)/.exec(cells[0]);
		entries.push({
			prNumber: prMatch ? Number(prMatch[1]) : undefined,
			bookmark: decodeCodeCell(cells[1]),
			base: decodeCodeCell(cells[2]),
			status: normalizeNavigationStatus(cells[3] ?? "open"),
		});
		if (entries.length >= MAX_NAVIGATION_ENTRIES) break;
	}
	return entries;
}

export function parseCommentMetadata(body: string): { schemaVersion: number } | undefined {
	if (!body.includes(KSTACK_COMMENT_MARKER)) return undefined;
	const match = /kstack-stack-schema-v(\d+)/.exec(body);
	return { schemaVersion: match ? Number(match[1]) : 0 };
}

export function findKstackComment(comments: readonly GitHubComment[], ghUser?: string): GitHubComment | undefined {
	for (const comment of comments) {
		if (!comment.body.includes(KSTACK_COMMENT_MARKER)) continue;
		if (ghUser !== undefined && (comment.user === undefined || comment.user.toLowerCase() !== ghUser.toLowerCase())) {
			continue;
		}
		const metadata = parseCommentMetadata(comment.body);
		if (
			metadata === undefined ||
			(metadata.schemaVersion !== 0 && metadata.schemaVersion !== KSTACK_COMMENT_SCHEMA_VERSION)
		) {
			continue;
		}
		return comment;
	}
	return undefined;
}

export function findNavigationAncestors(
	published: readonly { bookmark: string; existingPr?: { number: number } }[],
	priorEntries: readonly NavigationEntry[],
): NavigationEntry[] {
	for (const [index, prior] of priorEntries.entries()) {
		if (
			published.some(
				(slice) =>
					(slice.existingPr !== undefined && slice.existingPr.number === prior.prNumber) ||
					slice.bookmark === prior.bookmark,
			)
		) {
			return priorEntries.slice(0, index);
		}
	}
	return [];
}

export function reconcileStackEntries(input: {
	published: readonly {
		bookmark: string;
		prNumber: number | undefined;
		targetBase: string;
		createPr: boolean;
	}[];
	priorEntries: readonly NavigationEntry[];
	statusByPr: Readonly<Record<number, string>>;
	defaultBranch: string;
}): NavigationEntry[] {
	const publishedSlices = input.published.map((slice) => ({
		bookmark: slice.bookmark,
		existingPr: slice.prNumber === undefined ? undefined : { number: slice.prNumber },
	}));
	const ancestors = findNavigationAncestors(publishedSlices, input.priorEntries).map((entry) => {
		const status = entry.prNumber === undefined ? "unknown" : (input.statusByPr[entry.prNumber] ?? entry.status);
		return { ...entry, status: normalizeNavigationStatus(status) };
	});
	const active = input.published.map((slice) => ({
		prNumber: slice.prNumber,
		bookmark: slice.bookmark,
		base: slice.targetBase.replace(/^refs\/heads\//, "") || input.defaultBranch,
		status: normalizeNavigationStatus(
			slice.prNumber === undefined
				? "unknown"
				: (input.statusByPr[slice.prNumber] ?? (slice.createPr ? "draft" : "open")),
		),
	}));
	return [...ancestors, ...active];
}

export function findPrForBookmark(prs: readonly OpenPullRequest[], bookmark: string): OpenPullRequest | undefined {
	const matches = prs.filter((pr) => pr.headRef === bookmark);
	return matches.length === 1 ? matches[0] : undefined;
}

export interface GitHubAdapter {
	getDefaultBranch(repo: GitHubRepository, cwd: string, signal?: AbortSignal): Promise<string>;
	listOpenPrs(repo: GitHubRepository, cwd: string, signal?: AbortSignal): Promise<OpenPullRequest[]>;
	listPrsForHead(repo: GitHubRepository, head: string, cwd: string, signal?: AbortSignal): Promise<OpenPullRequest[]>;
	getAuthenticatedUser(cwd: string, signal?: AbortSignal): Promise<string | undefined>;
	getPrStatus(repo: GitHubRepository, prNumber: number, cwd: string, signal?: AbortSignal): Promise<NavigationStatus>;
	getPrComments(repo: GitHubRepository, prNumber: number, cwd: string, signal?: AbortSignal): Promise<GitHubComment[]>;
	createDraftPr(input: {
		repo: GitHubRepository;
		bookmark: string;
		base: string;
		title: string;
		cwd: string;
		signal?: AbortSignal;
	}): Promise<OpenPullRequest>;
	updatePrBase(input: {
		repo: GitHubRepository;
		prNumber: number;
		base: string;
		cwd: string;
		signal?: AbortSignal;
	}): Promise<void>;
	createOrUpdateComment(input: {
		repo: GitHubRepository;
		prNumber: number;
		body: string;
		existingCommentId?: number;
		cwd: string;
		signal?: AbortSignal;
	}): Promise<{ id: number }>;
}

export class GitHubError extends Error {
	readonly kind: "failed" | "indeterminate";
	constructor(message: string, kind: "failed" | "indeterminate" = "failed") {
		super(message);
		this.kind = kind;
	}
}

export function createGitHubAdapter(run: ProcessRunner): GitHubAdapter {
	return {
		async getDefaultBranch(repo, cwd, signal) {
			const result = await runGh(run, ["api", `/repos/${repo.owner}/${repo.repo}`, "--jq", ".default_branch"], {
				cwd,
				signal,
			});
			const branch = result.stdout.trim();
			if (!branch) throw new GitHubError(`Could not read default branch for ${repo.owner}/${repo.repo}.`);
			return branch;
		},
		async listOpenPrs(repo, cwd, signal) {
			return listPulls(run, repo, cwd, "open", signal);
		},
		async listPrsForHead(repo, head, cwd, signal) {
			const prs = await listPulls(run, repo, cwd, "all", signal);
			return prs.filter((pr) => pr.headRef === head);
		},
		async getAuthenticatedUser(cwd, signal) {
			try {
				const result = await runGh(run, ["api", "user", "--jq", ".login"], { cwd, signal });
				return result.stdout.trim() || undefined;
			} catch {
				return undefined;
			}
		},
		async getPrStatus(repo, prNumber, cwd, signal) {
			const result = await runGh(
				run,
				["api", `/repos/${repo.owner}/${repo.repo}/pulls/${prNumber}`, "--jq", "{state, merged, draft}"],
				{ cwd, signal },
			);
			return parsePrStatus(result.stdout, prNumber);
		},
		async getPrComments(repo, prNumber, cwd, signal) {
			const result = await runGh(
				run,
				[
					"api",
					`/repos/${repo.owner}/${repo.repo}/issues/${prNumber}/comments`,
					"--jq",
					".[] | {id, body, user: .user.login}",
					"--paginate",
				],
				{ cwd, signal },
			);
			return parseComments(result.stdout, prNumber);
		},
		async createDraftPr(input) {
			const created = await runGh(
				run,
				[
					"pr",
					"create",
					"--repo",
					`${input.repo.owner}/${input.repo.repo}`,
					"--head",
					input.bookmark,
					"--base",
					input.base,
					"--title",
					input.title,
					"--body",
					`Stacked PR for bookmark \`${input.bookmark}\`.`,
					"--draft",
				],
				{ cwd: input.cwd, signal: input.signal },
			);
			const prUrl = created.stdout.trim();
			try {
				const viewed = await runGh(
					run,
					["pr", "view", prUrl, "--json", "number,headRefName,baseRefName,title,isDraft,url"],
					{ cwd: input.cwd, signal: input.signal },
				);
				const info = parseCreatedPr(viewed.stdout, prUrl, input.repo);
				if (info) return info;
			} catch {
				/* fall through to the unresolved-create error */
			}
			throw new GitHubError(
				`Created PR for bookmark ${JSON.stringify(input.bookmark)} at ${JSON.stringify(prUrl)}, but could not read its metadata. Run plan again to continue safely.`,
			);
		},
		async updatePrBase(input) {
			await runGh(
				run,
				[
					"api",
					`/repos/${input.repo.owner}/${input.repo.repo}/pulls/${input.prNumber}`,
					"--method",
					"PATCH",
					"--field",
					`base=${input.base}`,
				],
				{ cwd: input.cwd, signal: input.signal },
			);
		},
		async createOrUpdateComment(input) {
			const args =
				input.existingCommentId !== undefined
					? [
							"api",
							`/repos/${input.repo.owner}/${input.repo.repo}/issues/comments/${input.existingCommentId}`,
							"--method",
							"PATCH",
							"--field",
							`body=${input.body}`,
						]
					: [
							"api",
							`/repos/${input.repo.owner}/${input.repo.repo}/issues/${input.prNumber}/comments`,
							"--method",
							"POST",
							"--field",
							`body=${input.body}`,
						];
			const result = await runGh(run, args, { cwd: input.cwd, signal: input.signal });
			try {
				const parsed: unknown = JSON.parse(result.stdout);
				if (typeof parsed === "object" && parsed !== null && "id" in parsed && Number.isSafeInteger(parsed.id)) {
					return { id: Number(parsed.id) };
				}
			} catch {
				/* keep a synthetic id only for an in-place update */
			}
			if (input.existingCommentId !== undefined) return { id: input.existingCommentId };
			throw new GitHubError(`Created comment on PR #${input.prNumber}, but could not read its id.`);
		},
	};
}

export function parseOpenPrs(text: string, repo: GitHubRepository): OpenPullRequest[] {
	const items = decodeJsonSequence(text);
	const expected = `${repo.owner}/${repo.repo}`.toLowerCase();
	const prs: OpenPullRequest[] = [];
	for (const item of items) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		const headRepository = record.headRepository;
		const headRepositoryOwner = record.headRepositoryOwner;
		if (headRepository === null || headRepository === undefined) continue;
		if (typeof headRepository !== "object") continue;
		const nameWithOwner = (headRepository as Record<string, unknown>).nameWithOwner;
		if (typeof nameWithOwner !== "string" || nameWithOwner.toLowerCase() !== expected) continue;
		const ownerLogin =
			typeof headRepositoryOwner === "object" && headRepositoryOwner !== null
				? (headRepositoryOwner as Record<string, unknown>).login
				: "";
		if (
			!Number.isSafeInteger(record.number) ||
			Number(record.number) <= 0 ||
			typeof record.headRefName !== "string" ||
			typeof record.baseRefName !== "string"
		) {
			continue;
		}
		prs.push({
			number: Number(record.number),
			headRef: record.headRefName,
			baseRef: record.baseRefName,
			title: typeof record.title === "string" ? record.title : "",
			draft: Boolean(record.isDraft),
			url: typeof record.url === "string" ? record.url : "",
			headOwner: typeof ownerLogin === "string" ? ownerLogin : "",
		});
	}
	return prs;
}

export function parsePrStatus(text: string, prNumber: number): NavigationStatus {
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		throw new GitHubError(`Could not parse status for PR #${prNumber}: invalid JSON.`);
	}
	if (
		typeof payload !== "object" ||
		payload === null ||
		typeof (payload as { merged?: unknown }).merged !== "boolean" ||
		((payload as { state?: unknown }).state !== "open" && (payload as { state?: unknown }).state !== "closed")
	) {
		throw new GitHubError(`Could not parse status for PR #${prNumber}: invalid response.`);
	}
	const record = payload as { merged: boolean; draft?: unknown; state: "open" | "closed" };
	if (record.merged) return "merged";
	if (record.draft) return "draft";
	return record.state;
}

async function listPulls(
	run: ProcessRunner,
	repo: GitHubRepository,
	cwd: string,
	state: "open" | "all",
	signal?: AbortSignal,
): Promise<OpenPullRequest[]> {
	const result = await runGh(
		run,
		[
			"api",
			"--method",
			"GET",
			`/repos/${repo.owner}/${repo.repo}/pulls`,
			"--field",
			`state=${state}`,
			"--field",
			"per_page=100",
			"--paginate",
			"--jq",
			".[] | {number, headRefName: .head.ref, baseRefName: .base.ref, title, isDraft: .draft, url: .html_url, headRepository: {nameWithOwner: .head.repo.full_name}, headRepositoryOwner: {login: .head.repo.owner.login}}",
		],
		{ cwd, signal },
	);
	return parseOpenPrs(result.stdout, repo);
}

function parseComments(text: string, prNumber: number): GitHubComment[] {
	const comments: GitHubComment[] = [];
	for (const item of decodeJsonSequence(text)) {
		if (typeof item !== "object" || item === null) {
			throw new GitHubError(`Could not parse comments for PR #${prNumber}: expected JSON objects.`);
		}
		const record = item as Record<string, unknown>;
		if (!Number.isSafeInteger(record.id) || Number(record.id) <= 0) continue;
		comments.push({
			id: Number(record.id),
			body: typeof record.body === "string" ? record.body : "",
			user: typeof record.user === "string" ? record.user : undefined,
		});
	}
	return comments;
}

function parseCreatedPr(text: string, fallbackUrl: string, repo: GitHubRepository): OpenPullRequest | undefined {
	try {
		const info: unknown = JSON.parse(text);
		if (typeof info !== "object" || info === null) return undefined;
		const record = info as Record<string, unknown>;
		if (!Number.isSafeInteger(record.number) || Number(record.number) <= 0) return undefined;
		if (typeof record.headRefName !== "string" || typeof record.baseRefName !== "string") return undefined;
		return {
			number: Number(record.number),
			headRef: record.headRefName,
			baseRef: record.baseRefName,
			title: typeof record.title === "string" ? record.title : "",
			draft: Boolean(record.isDraft),
			url: typeof record.url === "string" ? record.url : fallbackUrl,
			headOwner: repo.owner,
		};
	} catch {
		return undefined;
	}
}

function decodeJsonSequence(text: string): unknown[] {
	const items: unknown[] = [];
	const trimmed = text.trim();
	if (!trimmed) return items;
	let offset = 0;
	while (offset < trimmed.length) {
		while (offset < trimmed.length && /\s/.test(trimmed[offset])) offset++;
		if (offset >= trimmed.length) break;
		const end = jsonValueEnd(trimmed, offset);
		if (end === undefined) throw new GitHubError("Could not parse GitHub JSON sequence.");
		const parsed: unknown = JSON.parse(trimmed.slice(offset, end));
		if (Array.isArray(parsed)) items.push(...parsed);
		else items.push(parsed);
		offset = end;
	}
	return items;
}

function jsonValueEnd(text: string, start: number): number | undefined {
	const opener = text[start];
	if (opener !== "{" && opener !== "[") return undefined;
	const closer = opener === "{" ? "}" : "]";
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === opener || (opener === "{" && ch === "[") || (opener === "[" && ch === "{")) {
			if (ch === opener) depth++;
			else {
				const nested = jsonValueEnd(text, i);
				if (nested === undefined) return undefined;
				i = nested - 1;
			}
		} else if (ch === closer) {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return undefined;
}

async function runGh(
	run: ProcessRunner,
	args: string[],
	options: { cwd: string; signal?: AbortSignal },
): Promise<{ stdout: string }> {
	const result = await run(["gh", ...args], {
		cwd: options.cwd,
		timeoutMs: GH_TIMEOUT_MS,
		signal: options.signal,
	});
	if (result.kind !== "ok") throw toGitHubError(result, args);
	if (result.code !== 0) {
		throw new GitHubError(
			`gh ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
		);
	}
	return { stdout: result.stdout };
}

function toGitHubError(result: CommandFailure, args: string[]): GitHubError {
	const summary = `gh ${args[0]}`;
	if (result.kind === "timeout" || result.kind === "cancelled" || result.kind === "uncertain") {
		return new GitHubError(`${summary} ended without a conclusive result (${result.kind}).`, "indeterminate");
	}
	return new GitHubError(`${summary} failed: ${result.message}`);
}

function encodeNavigationEntries(entries: readonly NavigationEntry[]): string {
	const payload = JSON.stringify(
		entries.map((entry) => ({
			pr_number: entry.prNumber ?? null,
			bookmark: entry.bookmark,
			base: entry.base,
			status: entry.status,
		})),
	);
	return Buffer.from(payload, "utf8").toString("base64url").replace(/=+$/, "");
}

function parseNavigationItem(item: unknown): NavigationEntry | undefined {
	if (typeof item !== "object" || item === null) return undefined;
	const record = item as Record<string, unknown>;
	const prNumber = record.pr_number;
	if (prNumber !== null && prNumber !== undefined && (!Number.isSafeInteger(prNumber) || Number(prNumber) <= 0)) {
		return undefined;
	}
	if (typeof record.bookmark !== "string" || typeof record.base !== "string" || typeof record.status !== "string") {
		return undefined;
	}
	return {
		prNumber: typeof prNumber === "number" ? prNumber : undefined,
		bookmark: record.bookmark,
		base: record.base,
		status: normalizeNavigationStatus(record.status),
	};
}

function markdownCode(value: string): string {
	const escaped = escapeHtml(value).replace(/\|/g, "&#124;");
	return `<code>${escaped}</code>`;
}

function decodeCodeCell(value: string): string {
	let cell = value.trim();
	if (cell.length >= 2 && cell.startsWith("`") && cell.endsWith("`")) cell = cell.slice(1, -1);
	else if (cell.startsWith("<code>") && cell.endsWith("</code>")) cell = cell.slice(6, -7);
	return unescapeHtml(cell);
}

function escapeHtml(value: string): string {
	return value.replace(/&/g, "\u0026amp;").replace(/</g, "\u0026lt;").replace(/>/g, "\u0026gt;");
}

function unescapeHtml(value: string): string {
	return value
		.replace(/&#124;/g, "|")
		.replace(/\u0026lt;/g, "<")
		.replace(/\u0026gt;/g, ">")
		.replace(/\u0026amp;/g, "&");
}

function capitalize(value: string): string {
	return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

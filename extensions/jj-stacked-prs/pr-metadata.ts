/** Bounded slice evidence and deterministic write-pr metadata generation. */

import { bookmarkRevset } from "./jj.ts";
import { MAX_TITLE_CHARS, type PrDocument, type PrMetadata, renderPrDocument } from "./pr-document.ts";
import { type RepositoryPrTemplate, renderRepositoryPrTemplate } from "./pr-template.ts";
import type { ProcessRunner } from "./process.ts";
import { DEFAULT_TIMEOUT_MS } from "./types.ts";

const LOG_CAP_BYTES = 32 * 1024;
const NAME_CAP_BYTES = 16 * 1024;

export interface PrMetadataRequest {
	cwd: string;
	bookmark: string;
	baseRevset: string;
	subject: string;
	repositoryTemplate?: RepositoryPrTemplate;
	signal?: AbortSignal;
}

interface PrSliceEvidence {
	log: string;
	names: string;
}

export type { PrMetadata };

export type PrMetadataGenerator = (request: PrMetadataRequest) => Promise<PrMetadata>;

export async function collectSliceEvidence(run: ProcessRunner, request: PrMetadataRequest): Promise<PrSliceEvidence> {
	const range = `(${request.baseRevset})..${bookmarkRevset(request.bookmark)}`;
	const controller = new AbortController();
	const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;

	async function collect(label: string, args: string[], stdoutCapBytes: number): Promise<string> {
		const result = await run(["jj", "--no-pager", ...args], {
			cwd: request.cwd,
			signal,
			timeoutMs: DEFAULT_TIMEOUT_MS,
			stdoutCapBytes,
		});
		if (result.kind !== "ok") throw new Error(`Could not collect the PR slice ${label}: ${result.message}`);
		return result.stdout;
	}

	try {
		const [log, names] = await Promise.all([
			collect("log", ["log", "-r", range, "--no-graph", "-T", 'description ++ "\\n"'], LOG_CAP_BYTES),
			collect("paths", ["diff", "--name-only", "-r", range], NAME_CAP_BYTES),
		]);
		if (!names.trim()) {
			throw new Error(`PR slice ${JSON.stringify(request.bookmark)} has an empty diff.`);
		}
		return { log, names };
	} finally {
		controller.abort();
	}
}

function firstLine(text: string): string {
	const line = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
	return line;
}

function sanitizeTitle(raw: string, fallback: string): string {
	let title = firstLine(raw).replace(/\.$/, "").trim();
	if (!title || title.length > MAX_TITLE_CHARS || /[\r\n\0]/.test(title)) {
		title = firstLine(fallback).replace(/\.$/, "").trim();
	}
	if (!title || title.length > MAX_TITLE_CHARS) {
		title = "Update stacked PR slice";
	}
	return title;
}

function uniqueNonEmpty(values: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

function pathGroups(names: string): { label: string; files: string[] }[] {
	const groups = new Map<string, string[]>();
	for (const raw of names.split(/\r?\n/)) {
		const path = raw.trim();
		if (!path) continue;
		const parts = path.split("/").filter(Boolean);
		const label = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? path);
		const files = groups.get(label) ?? [];
		const base = parts[parts.length - 1] ?? path;
		files.push(base);
		groups.set(label, files);
	}
	return [...groups.entries()].map(([label, files]) => ({ label, files: uniqueNonEmpty(files) }));
}

export function documentFromSliceEvidence(request: PrMetadataRequest, evidence: PrSliceEvidence): PrDocument {
	const title = sanitizeTitle(request.subject, request.bookmark);
	const descriptions = uniqueNonEmpty(evidence.log.split(/\r?\n/).map((line) => line.trim().replace(/\.$/, ""))).filter(
		(line) => line && line !== title,
	);
	const summaryBullets = uniqueNonEmpty([title, ...descriptions]).slice(0, 6);
	const firstSummary = summaryBullets[0] ?? title;
	const groups = pathGroups(evidence.names).slice(0, 5);
	const reviewSteps = groups.map((group) => ({
		label: group.label,
		description: `Review changes in ${group.files.slice(0, 4).join(", ")}.`,
	}));
	const firstStep = reviewSteps[0];
	if (firstStep === undefined) {
		throw new Error(`PR slice ${JSON.stringify(request.bookmark)} has an empty review guide.`);
	}
	return {
		title,
		summaryBullets: [firstSummary, ...summaryBullets.slice(1)],
		reviewSteps: [firstStep, ...reviewSteps.slice(1)],
	};
}

export async function generateDeterministicPrMetadata(
	run: ProcessRunner,
	request: PrMetadataRequest,
): Promise<PrMetadata> {
	const evidence = await collectSliceEvidence(run, request);
	const document = documentFromSliceEvidence(request, evidence);
	return request.repositoryTemplate
		? renderRepositoryPrTemplate(document, request.repositoryTemplate)
		: renderPrDocument(document);
}

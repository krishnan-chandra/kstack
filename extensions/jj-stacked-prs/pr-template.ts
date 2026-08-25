import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { MAX_BODY_BYTES, type PrDocument, type PrMetadata } from "./pr-document.ts";

const MAX_TEMPLATE_BYTES = 24 * 1024;
const DEFAULT_TEMPLATE_PATHS = [
	".github/pull_request_template.md",
	".github/PULL_REQUEST_TEMPLATE.md",
	"pull_request_template.md",
	"PULL_REQUEST_TEMPLATE.md",
	"docs/pull_request_template.md",
	"docs/PULL_REQUEST_TEMPLATE.md",
] as const;
const TEMPLATE_DIRECTORIES = [".github/PULL_REQUEST_TEMPLATE", ".github/pull_request_template"] as const;

type TemplateSection = "summary" | "why" | "testing" | "other";

export interface RepositoryPrTemplate {
	readonly path: string;
	readonly source: string;
	readonly requiresConventionalTitle: boolean;
	readonly minimumDescriptionWords: number | undefined;
}

function canonicalizeTemplateSource(path: string, raw: string): string {
	const source = raw.replace(/\r\n?/g, "\n");
	let cursor = 0;
	while (cursor < source.length) {
		const open = source.indexOf("<!--", cursor);
		if (open === -1) break;
		const close = source.indexOf("-->", open + 4);
		if (close === -1) throw new Error(`Pull-request template ${JSON.stringify(path)} has an unclosed HTML comment.`);
		cursor = close + 3;
	}
	return source;
}

function readRegularFile(path: string): string | undefined {
	try {
		if (!statSync(path).isFile()) return undefined;
		const raw = readFileSync(path, "utf8");
		if (Buffer.byteLength(raw, "utf8") > MAX_TEMPLATE_BYTES) {
			throw new Error(`Pull-request template ${JSON.stringify(path)} exceeds ${MAX_TEMPLATE_BYTES} bytes.`);
		}
		return canonicalizeTemplateSource(path, raw);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function directoryTemplates(cwd: string): string[] {
	const paths: string[] = [];
	for (const relative of TEMPLATE_DIRECTORIES) {
		const directory = join(cwd, relative);
		try {
			if (!statSync(directory).isDirectory()) continue;
			for (const name of readdirSync(directory).sort()) {
				if (name.toLowerCase().endsWith(".md")) paths.push(join(directory, name));
			}
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
			throw error;
		}
	}
	return paths;
}

function titleContract(
	source: string,
): Pick<RepositoryPrTemplate, "requiresConventionalTitle" | "minimumDescriptionWords"> {
	const requiresConventionalTitle =
		/conventional commits?/i.test(source) || /`type(?:\(scope\))?!?: description`/i.test(source);
	const wordMatch = source.match(/at least\s+(\d+|one|two|three|four|five)\s+words?\s+after\s+the\s+colon/i);
	type NamedNumbers = Readonly<Record<string, number>>;
	const namedNumbers: NamedNumbers = { one: 1, two: 2, three: 3, four: 4, five: 5 };
	const rawMinimum = wordMatch?.[1]?.toLowerCase();
	let minimumDescriptionWords: number | undefined;
	if (rawMinimum !== undefined) {
		minimumDescriptionWords = /^\d+$/.test(rawMinimum) ? Number(rawMinimum) : namedNumbers[rawMinimum];
	}
	return { requiresConventionalTitle, minimumDescriptionWords };
}

export function discoverRepositoryPrTemplate(cwd: string): RepositoryPrTemplate | undefined {
	const candidates: Array<{ path: string; source: string }> = [];
	for (const relative of DEFAULT_TEMPLATE_PATHS) {
		const path = join(cwd, relative);
		const source = readRegularFile(path);
		if (source !== undefined) candidates.push({ path, source });
	}
	for (const path of directoryTemplates(cwd)) {
		const source = readRegularFile(path);
		if (source !== undefined) candidates.push({ path, source });
	}
	const unique = [
		...new Map(
			candidates.map((candidate) => {
				const stat = statSync(candidate.path);
				return [`${stat.dev}:${stat.ino}`, candidate] as const;
			}),
		).values(),
	];
	if (unique.length === 0) return undefined;
	if (unique.length > 1) {
		throw new Error(
			`Multiple pull-request templates exist; select one before publication: ${unique.map((item) => item.path).join(", ")}`,
		);
	}
	const template = unique[0];
	if (template === undefined) return undefined;
	return { path: template.path, source: template.source, ...titleContract(template.source) };
}

function sectionForHeading(heading: string): TemplateSection {
	const normalized = heading
		.replace(/[*_`]/g, "")
		.replace(/[^a-z0-9]+/gi, " ")
		.trim()
		.toLowerCase();
	if (/\b(?:why|motivation|rationale|context|problem)\b/.test(normalized)) return "why";
	if (/\b(?:test|tested|testing|verification|validation)\b/.test(normalized)) return "testing";
	if (/\bsummary\b|\bdescription\b|\bchanges?\b|\bwhat (?:changed|changes|are we doing)\b/.test(normalized)) {
		return "summary";
	}
	return "other";
}

function summaryContent(doc: PrDocument): string[] {
	return [
		...doc.summaryBullets.map((bullet) => `- ${bullet.trim()}`),
		"",
		"**Review guide**",
		"",
		...doc.reviewSteps.map((step, index) => `${index + 1}. **${step.label.trim()}** — ${step.description.trim()}`),
	];
}

function contentForSection(section: TemplateSection, doc: PrDocument): string[] {
	if (section === "summary") return summaryContent(doc);
	if (section === "why") {
		return ["This PR keeps this committed stack slice independently reviewable and publishable."];
	}
	if (section === "testing") {
		return ["- Not run by `jj_stack_publish`; rely on repository checks and add verified results before merging."];
	}
	return [];
}

function withoutFencedRegions(source: string): string {
	const output: string[] = [];
	let fence: { marker: "`" | "~"; length: number } | undefined;
	for (const line of source.split("\n")) {
		const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
		if (!fence && opening) {
			const token = opening[1];
			fence = { marker: token.startsWith("`") ? "`" : "~", length: token.length };
			output.push("");
			continue;
		}
		if (fence) {
			const closing = line.match(/^ {0,3}(`+|~+)\s*$/);
			if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) fence = undefined;
			output.push("");
			continue;
		}
		output.push(line);
	}
	return output.join("\n");
}

function requiredTemplateFragments(source: string): string[] {
	return [...withoutFencedRegions(source).matchAll(/<!--[\s\S]*?-->|^#{1,6}\s+\S.*$|^[-*]\s+\[[ xX]\]\s+\S.*$/gm)].map(
		(match) => match[0].trim(),
	);
}

function validateRecognizedSections(body: string, template: RepositoryPrTemplate): void {
	const lines = withoutFencedRegions(body.replace(/<!--[\s\S]*?-->/g, "")).split("\n");
	for (let index = 0; index < lines.length; index++) {
		const heading = (lines[index] ?? "").match(/^#{1,6}\s+(.+?)\s*$/);
		if (!heading || sectionForHeading(heading[1]) === "other") continue;
		let hasContent = false;
		for (let cursor = index + 1; cursor < lines.length; cursor++) {
			const line = (lines[cursor] ?? "").trim();
			if (/^#{1,6}\s+\S/.test(line)) break;
			if (line && !/^[-*]\s+\[\s*\]\s+/.test(line)) {
				hasContent = true;
				break;
			}
		}
		if (!hasContent) {
			throw new Error(`PR body leaves template section ${JSON.stringify(heading[1])} empty in ${template.path}.`);
		}
	}
}

export function validatePrMetadataAgainstTemplate(metadata: PrMetadata, template: RepositoryPrTemplate): void {
	let cursor = 0;
	for (const fragment of requiredTemplateFragments(template.source)) {
		const index = metadata.body.indexOf(fragment, cursor);
		if (index === -1) {
			throw new Error(
				`PR body does not preserve required template fragment ${JSON.stringify(fragment)} in order from ${template.path}.`,
			);
		}
		cursor = index + fragment.length;
	}
	validateRecognizedSections(metadata.body, template);
	if (template.requiresConventionalTitle) {
		const match = metadata.title.match(/^[a-z][a-z0-9-]*(?:\([^)\r\n]+\))?!?:\s+(.+)$/);
		if (!match) throw new Error(`PR title does not follow the Conventional Commits contract in ${template.path}.`);
		if (template.minimumDescriptionWords !== undefined) {
			const words = match[1].trim().split(/\s+/).filter(Boolean);
			if (words.length < template.minimumDescriptionWords) {
				throw new Error(
					`PR title needs at least ${template.minimumDescriptionWords} words after the colon for ${template.path}.`,
				);
			}
		}
	}
}

export function renderRepositoryPrTemplate(doc: PrDocument, template: RepositoryPrTemplate): PrMetadata {
	const lines = template.source.trimEnd().split("\n");
	const output: string[] = [];
	let insertedSummary = false;
	let fence: { marker: "`" | "~"; length: number } | undefined;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		output.push(line);
		const fenceToken = line.match(/^ {0,3}(`{3,}|~{3,})/);
		if (!fence && fenceToken) {
			const token = fenceToken[1];
			fence = { marker: token.startsWith("`") ? "`" : "~", length: token.length };
			continue;
		}
		if (fence) {
			const closing = line.match(/^ {0,3}(`+|~+)\s*$/);
			if (closing && closing[1][0] === fence.marker && closing[1].length >= fence.length) fence = undefined;
			continue;
		}
		const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
		if (!heading) continue;
		const section = sectionForHeading(heading[1]);
		if (section === "other") continue;
		if (section === "summary") insertedSummary = true;
		while (index + 1 < lines.length && (lines[index + 1] ?? "").trim() === "") {
			output.push(lines[index + 1] ?? "");
			index++;
		}
		while (index + 1 < lines.length && (lines[index + 1] ?? "").trimStart().startsWith("<!--")) {
			output.push(lines[index + 1] ?? "");
			index++;
			while (index + 1 < lines.length && !(lines[index] ?? "").includes("-->")) {
				output.push(lines[index + 1] ?? "");
				index++;
			}
		}
		output.push("", ...contentForSection(section, doc), "");
	}
	if (!insertedSummary) output.push("", ...summaryContent(doc));
	const metadata = {
		title: doc.title.trim(),
		body: output
			.join("\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim(),
	};
	if (Buffer.byteLength(metadata.body, "utf8") > MAX_BODY_BYTES) {
		throw new Error(`PR body exceeds ${MAX_BODY_BYTES} bytes.`);
	}
	validatePrMetadataAgainstTemplate(metadata, template);
	return metadata;
}

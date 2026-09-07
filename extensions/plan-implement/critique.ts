/** Parse the adversary's Markdown critique into the debate domain model. */

import type { Critique, CritiqueFinding, ResolvedCritiqueFinding } from "./types.ts";

type CritiqueParseResult = { ok: true; critique: Critique } | { ok: false; error: string };
type SectionName = "blocking" | "suggestions" | "resolved";

function withoutFencedBlocks(markdown: string): string {
	const lines = markdown.split("\n");
	let fence: string | undefined;
	return lines
		.map((line) => {
			const match = /^\s*(```+|~~~+)/.exec(line);
			if (match) {
				if (fence === undefined) fence = match[1]?.[0];
				else if (match[1]?.startsWith(fence)) fence = undefined;
				return "[fenced content]";
			}
			return fence === undefined ? line : "[fenced content]";
		})
		.join("\n");
}

function sectionName(line: string): SectionName | undefined {
	const heading = /^##\s+(.+?)\s*$/.exec(line)?.[1]?.toLowerCase();
	if (heading === "blocking") return "blocking";
	if (heading === "suggestions") return "suggestions";
	if (heading === "resolved from previous round") return "resolved";
	return undefined;
}

function parseFinding(line: string, prefix: "B" | "S"): CritiqueFinding | undefined {
	const match = new RegExp(`^\\s*-\\s*\\[(${prefix}-\\d+)\\]\\s+(.+?)\\s*$`, "u").exec(line);
	if (!match?.[1] || !match[2]) return undefined;
	return { id: match[1], text: match[2] };
}

function parseResolved(line: string): ResolvedCritiqueFinding | undefined {
	const match = /^\s*-\s*(B-\d+):\s+(.+?)\s*$/.exec(line);
	if (!match?.[1] || !match[2]) return undefined;
	return { id: match[1], summary: match[2] };
}

function duplicateId(findings: readonly CritiqueFinding[]): string | undefined {
	const seen = new Set<string>();
	for (const finding of findings) {
		if (seen.has(finding.id)) return finding.id;
		seen.add(finding.id);
	}
	return undefined;
}

/** Parse one critique. Approve-with-blockers is conservatively downgraded to revise. */
export function parseCritique(raw: string): CritiqueParseResult {
	const markdown = withoutFencedBlocks(raw);
	const verdictMatches = [...markdown.matchAll(/^Verdict:\s*(approve|revise)\s*$/gimu)];
	if (verdictMatches.length !== 1)
		return { ok: false, error: "Critique must contain exactly one approve or revise verdict." };
	const declaredVerdict = verdictMatches[0]?.[1]?.toLowerCase();
	if (declaredVerdict !== "approve" && declaredVerdict !== "revise") {
		return { ok: false, error: "Critique verdict is malformed." };
	}
	const blocking: CritiqueFinding[] = [];
	const suggestions: CritiqueFinding[] = [];
	const resolved: ResolvedCritiqueFinding[] = [];
	const foundSections = new Set<SectionName>();
	let section: SectionName | undefined;
	for (const line of markdown.split("\n")) {
		const heading = sectionName(line);
		if (heading) {
			section = heading;
			foundSections.add(heading);
			continue;
		}
		if (section === "blocking") {
			const finding = parseFinding(line, "B");
			if (finding) blocking.push(finding);
			else if (line.trim() && !/^None\.$/i.test(line.trim())) {
				return {
					ok: false,
					error: "Critique Blocking section contains unparseable content; use - [B-N] text or None.",
				};
			}
		} else if (section === "suggestions") {
			const finding = parseFinding(line, "S");
			if (finding) suggestions.push(finding);
		} else if (section === "resolved") {
			const finding = parseResolved(line);
			if (finding) resolved.push(finding);
		}
	}
	if (!foundSections.has("blocking") || !foundSections.has("suggestions")) {
		return { ok: false, error: "Critique must contain Blocking and Suggestions sections." };
	}
	const duplicate = duplicateId([...blocking, ...suggestions]);
	if (duplicate) return { ok: false, error: `Critique repeats finding ID ${duplicate}.` };
	const verdict = declaredVerdict === "approve" && blocking.length > 0 ? "revise" : declaredVerdict;
	return { ok: true, critique: { verdict, blocking, suggestions, resolved, raw } };
}

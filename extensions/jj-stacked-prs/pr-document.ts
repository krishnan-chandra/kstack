/**
 * Single write-pr document shape. Markdown is a renderer of this type,
 * not the source of truth the publisher parses from a model.
 */

export const MAX_TITLE_CHARS = 120;
export const MAX_BODY_BYTES = 30 * 1024;

interface ReviewStep {
	readonly label: string;
	readonly description: string;
}

export interface PrDocument {
	readonly title: string;
	readonly summaryBullets: readonly [string, ...string[]];
	readonly reviewSteps: readonly [ReviewStep, ...ReviewStep[]];
}

export interface PrMetadata {
	readonly title: string;
	readonly body: string;
}

function hasPlaceholder(text: string): boolean {
	return (
		/\b(?:tbd|placeholder)\b|\[(?:todo|tbd)\]|<(?:todo|tbd)>|\btodo\s*[:\-–—([]/i.test(text) || /\bTODO\b/.test(text)
	);
}

function validatePrDocument(doc: PrDocument): void {
	const title = doc.title.trim();
	if (!title || title.length > MAX_TITLE_CHARS || title.endsWith(".") || /[\r\n\0]/.test(title)) {
		throw new Error(
			`PR title must be non-empty, single-line, at most ${MAX_TITLE_CHARS} characters, and have no trailing period.`,
		);
	}
	if (hasPlaceholder(title)) {
		throw new Error("PR title contains placeholder text.");
	}
	for (const bullet of doc.summaryBullets) {
		if (!bullet.trim()) {
			throw new Error("PR summary bullet cannot be empty.");
		}
		if (hasPlaceholder(bullet)) {
			throw new Error("PR summary contains placeholder text.");
		}
	}
	for (const step of doc.reviewSteps) {
		if (!step.label.trim() || !step.description.trim()) {
			throw new Error("PR review step must have both a label and a description.");
		}
		if (hasPlaceholder(step.label) || hasPlaceholder(step.description)) {
			throw new Error("PR review guide contains placeholder text.");
		}
	}
}

export function renderPrDocument(doc: PrDocument): PrMetadata {
	validatePrDocument(doc);
	const body = [
		"## Summary",
		"",
		...doc.summaryBullets.map((bullet) => `- ${bullet.trim()}`),
		"",
		"## Review guide",
		"",
		...doc.reviewSteps.map((step, index) => `${index + 1}. **${step.label.trim()}** — ${step.description.trim()}`),
	].join("\n");
	if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
		throw new Error(`PR body exceeds ${MAX_BODY_BYTES} bytes.`);
	}
	return { title: doc.title.trim(), body };
}

export function parsePrMarkdown(title: string, body: string): PrDocument {
	const normalizedTitle = title.trim();
	const lines = body.replace(/\r\n/g, "\n").trim().split("\n");
	if (lines[0] !== "## Summary") {
		throw new Error("PR metadata body must start with a Summary heading and bullet list.");
	}
	const reviewGuideIndex = lines.findIndex((line, index) => index > 0 && line === "## Review guide");
	if (reviewGuideIndex === -1) {
		throw new Error("PR metadata body must include a thematic Review guide with numbered steps.");
	}

	const summaryBullets: string[] = [];
	for (const line of lines.slice(1, reviewGuideIndex)) {
		const match = line.match(/^\s*[-*]\s+(\S.*)$/);
		if (match) summaryBullets.push(match[1].trim());
	}
	if (summaryBullets.length === 0) {
		throw new Error("PR metadata body must start with a Summary heading and bullet list.");
	}

	const reviewSteps: ReviewStep[] = [];
	for (const line of lines.slice(reviewGuideIndex + 1)) {
		const match = line.match(/^\s*\d+\.\s+\*\*([^*]+)\*\*\s+[-—–]\s+(\S.*)$/);
		if (match) {
			reviewSteps.push({ label: match[1].trim(), description: match[2].trim() });
		}
	}
	if (reviewSteps.length === 0) {
		throw new Error("PR metadata body must include a thematic Review guide with numbered steps.");
	}

	const firstBullet = summaryBullets[0];
	const firstStep = reviewSteps[0];
	if (firstBullet === undefined || firstStep === undefined) {
		throw new Error("PR metadata body must start with a Summary heading and bullet list.");
	}
	const doc: PrDocument = {
		title: normalizedTitle,
		summaryBullets: [firstBullet, ...summaryBullets.slice(1)],
		reviewSteps: [firstStep, ...reviewSteps.slice(1)],
	};
	validatePrDocument(doc);
	return doc;
}

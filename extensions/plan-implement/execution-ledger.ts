/**
 * The machine-checkable contract between an approved plan and implementation.
 *
 * Plans deliberately use a small, explicit item format so the parent can prove
 * that the implementer did not silently drop a step or acceptance criterion.
 */

export type PlanItemKind = "step" | "criterion";
export type LedgerStatus = "done" | "blocked" | "skip";

export interface PlanItem {
	id: string;
	kind: PlanItemKind;
	text: string;
}

export interface LedgerEntry extends PlanItem {
	status: LedgerStatus;
	reason?: string;
}

export type PlanItemsResult = { ok: true; items: PlanItem[] } | { ok: false; error: string };
export type LedgerValidation = { ok: true; ledger: string; entries: LedgerEntry[] } | { ok: false; error: string };

function normalizeText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function sectionLines(plan: string, heading: RegExp): string[] {
	const lines = plan.split(/\r?\n/);
	let fenced = false;
	let start = -1;
	for (let index = 0; index < lines.length; index++) {
		const trimmed = lines[index].trim();
		if (/^```/.test(trimmed)) {
			fenced = !fenced;
			continue;
		}
		if (!fenced && heading.test(trimmed)) {
			start = index;
			break;
		}
	}
	if (start === -1) return [];
	const result: string[] = [];
	fenced = false;
	for (const line of lines.slice(start + 1)) {
		const trimmed = line.trim();
		if (/^```/.test(trimmed)) {
			fenced = !fenced;
			continue;
		}
		if (!fenced && /^#{2,6}\s+/.test(trimmed)) break;
		result.push(line);
	}
	return result;
}

function collectItems(lines: string[], idPattern: RegExp): { items: PlanItem[]; malformed?: string } {
	const items: PlanItem[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		const match = line.match(idPattern);
		if (!match) return { items, malformed: line.trim() };
		const text = normalizeText(match[2]);
		if (text) items.push({ id: match[1].toUpperCase(), kind: /^AC-/i.test(match[1]) ? "criterion" : "step", text });
	}
	return { items };
}

/** Extract the explicitly formatted steps and acceptance criteria from a plan. */
export function extractPlanItems(plan: string): PlanItemsResult {
	const stepLines = sectionLines(plan, /^##\s+Ordered implementation steps\s*$/i);
	const criterionLines = sectionLines(plan, /^##\s+Acceptance criteria\s*$/i);
	const stepResult = collectItems(
		stepLines,
		/^\s*(?:\d+[.)]\s+)?\[([^\]]+)\]\s+(.+?)\s*$/,
	);
	const criterionResult = collectItems(
		criterionLines,
		/^\s*[-*]\s+\[([^\]]+)\]\s+(.+?)\s*$/,
	);
	if (stepResult.malformed) return { ok: false, error: `Malformed ordered implementation step: ${stepResult.malformed}` };
	if (criterionResult.malformed) return { ok: false, error: `Malformed acceptance criterion: ${criterionResult.malformed}` };
	const steps = stepResult.items;
	const criteria = criterionResult.items;
	if (steps.length === 0) {
		return { ok: false, error: "Approved plan has no ordered implementation steps in the required [STEP-n] format." };
	}
	if (steps.some((item) => !/^STEP-\d+$/i.test(item.id))) {
		return { ok: false, error: "Ordered implementation steps must use unique [STEP-n] identifiers." };
	}
	if (criteria.some((item) => !/^AC-\d+$/i.test(item.id))) {
		return { ok: false, error: "Acceptance criteria must use unique [AC-n] identifiers." };
	}
	for (const [index, item] of steps.entries()) {
		if (item.id !== `STEP-${index + 1}`) return { ok: false, error: "Ordered implementation steps must use consecutive [STEP-n] identifiers." };
	}
	for (const [index, item] of criteria.entries()) {
		if (item.id !== `AC-${index + 1}`) return { ok: false, error: "Acceptance criteria must use consecutive [AC-n] identifiers." };
	}
	const ids = new Set<string>();
	for (const item of [...steps, ...criteria]) {
		if (ids.has(item.id)) return { ok: false, error: `Approved plan repeats item ${item.id}.` };
		ids.add(item.id);
	}
	return { ok: true, items: [...steps, ...criteria] };
}

/** Create the mutable ledger copied from the approved plan before implementation. */
export function createExecutionLedger(plan: string): { ok: true; ledger: string; items: PlanItem[] } | { ok: false; error: string } {
	const parsed = extractPlanItems(plan);
	if (!parsed.ok) return parsed;
	const lines = parsed.items.map((item) => `- [${item.id}] ${item.text} — blocked: implementation status not yet recorded`);
	return { ok: true, ledger: ["## Execution Ledger", "", ...lines, ""].join("\n"), items: parsed.items };
}

function parseLedger(output: string): { ok: true; entries: LedgerEntry[] } | { ok: false; error: string } {
	const lines = output.split(/\r?\n/);
	const start = lines.findIndex((line) => /^##\s+Execution Ledger\s*$/i.test(line.trim()));
	if (start === -1) return { ok: false, error: "Implementer result is missing the required ## Execution Ledger section." };
	const entries: LedgerEntry[] = [];
	for (const line of lines.slice(start + 1)) {
		if (/^#{2,6}\s+/.test(line.trim())) break;
		if (!line.trim()) continue;
		const match = line.match(/^\s*[-*]\s+\[([^\]]+)\]\s+(.+?)\s+—\s+(done|blocked|skip)(?::\s*(.*))?\s*$/i);
		if (!match) return { ok: false, error: `Malformed execution-ledger entry: ${line.trim()}` };
		const status = match[3].toLowerCase() as LedgerStatus;
		const reason = normalizeText(match[4] ?? "");
		if ((status === "blocked" || status === "skip") && !reason) {
			return { ok: false, error: `${match[1]} must include a reason after ${status}:` };
		}
		if (status === "done" && reason) return { ok: false, error: `${match[1]} must use exactly "done" without a reason.` };
		entries.push({
			id: match[1].toUpperCase(),
			kind: /^AC-\d+$/i.test(match[1]) ? "criterion" : "step",
			text: normalizeText(match[2]),
			status,
			...(reason ? { reason } : {}),
		});
	}
	if (entries.length === 0) return { ok: false, error: "Execution ledger has no entries." };
	return { ok: true, entries };
}

/** Preserve the implementer's ledger section for panel review, including omissions. */
export function extractExecutionLedger(output: string): string {
	const lines = output.split(/\r?\n/);
	const start = lines.findIndex((line) => /^##\s+Execution Ledger\s*$/i.test(line.trim()));
	if (start === -1) return "## Execution Ledger\n\n(missing from implementer result)\n";
	const body: string[] = [];
	for (const line of lines.slice(start)) {
		if (body.length > 0 && /^#{2,6}\s+/.test(line.trim())) break;
		body.push(line);
	}
	return `${body.join("\n").trim()}\n`;
}

/** Prove item-by-item parity and return a canonical ledger for panel review. */
export function validateExecutionLedger(plan: string, output: string): LedgerValidation {
	const expected = extractPlanItems(plan);
	if (!expected.ok) return expected;
	const actual = parseLedger(output);
	if (!actual.ok) return actual;
	const expectedById = new Map(expected.items.map((item) => [item.id, item]));
	const expectedOrder = expected.items.map((item) => item.id);
	const seen = new Set<string>();
	for (const [index, entry] of actual.entries.entries()) {
		if (entry.id !== expectedOrder[index]) return { ok: false, error: `Execution ledger reordered ${entry.id}; expected ${expectedOrder[index]}.` };
		if (seen.has(entry.id)) return { ok: false, error: `Execution ledger repeats ${entry.id}.` };
		seen.add(entry.id);
		const item = expectedById.get(entry.id);
		if (!item) return { ok: false, error: `Execution ledger contains plan item ${entry.id}, which is not in the approved plan.` };
		if (item.kind !== entry.kind || normalizeText(item.text) !== entry.text) {
			return { ok: false, error: `Execution ledger text for ${entry.id} does not exactly match the approved plan.` };
		}
	}
	const missing = expected.items.filter((item) => !seen.has(item.id));
	if (missing.length > 0) return { ok: false, error: `Execution ledger omitted approved plan item(s): ${missing.map((item) => item.id).join(", ")}.` };
	const canonical = [
		"## Execution Ledger",
		"",
		...actual.entries.map((entry) => `- [${entry.id}] ${entry.text} — ${entry.status}${entry.reason ? `: ${entry.reason}` : ""}`),
		"",
	].join("\n");
	return { ok: true, ledger: canonical, entries: actual.entries };
}

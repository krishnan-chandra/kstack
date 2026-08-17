const MAX_AFFECTED_REFS = 50;
const MAX_OUTPUT_CHARS = 100_000;
const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: Graphite emits ANSI CSI color sequences in dry-run output.
const ANSI_CSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

type GraphiteDryRunOperation = "submit" | "merge";

type GraphiteDryRunParseResult = { ok: true; affectedRefs: readonly string[] } | { ok: false; error: string };

function safeRef(ref: string): boolean {
	return (
		ref.length <= 240 &&
		SAFE_REF_RE.test(ref) &&
		!ref.includes("..") &&
		!ref.includes("//") &&
		!ref.endsWith(".") &&
		!ref.endsWith(".lock")
	);
}

/** Parse the bounded branch list Graphite prints before a dry-run mutation. */
export function parseGraphiteDryRunAffectedRefs(
	raw: string,
	operation: GraphiteDryRunOperation,
): GraphiteDryRunParseResult {
	if (raw.length === 0 || raw.length > MAX_OUTPUT_CHARS) {
		return { ok: false, error: "Graphite dry-run output was empty or too large." };
	}
	const marker = operation === "submit" ? "Preparing to submit PRs for the following branches" : "Preparing to merge:";
	const lines = raw
		.replace(ANSI_CSI_RE, "")
		.split(/\r?\n/)
		.map((line) => line.trim());
	const start = lines.findIndex((line) => line.startsWith(marker));
	if (start < 0) return { ok: false, error: `Graphite ${operation} dry run did not identify its affected branches.` };
	const end = lines.findIndex((line, index) => index > start && /Dry run complete\.?$/i.test(line));
	if (end < 0) return { ok: false, error: `Graphite ${operation} dry run did not report completion.` };

	const affectedRefs: string[] = [];
	const seen = new Set<string>();
	for (const line of lines.slice(start + 1, end)) {
		if (!line.startsWith("▸")) continue;
		const match = /^▸\s+([^\s(]+)(?:\s+\(|\s*$)/.exec(line);
		const ref = match?.[1];
		if (!ref || !safeRef(ref))
			return { ok: false, error: `Graphite ${operation} dry run contained an invalid branch.` };
		if (seen.has(ref)) return { ok: false, error: `Graphite ${operation} dry run listed ${ref} more than once.` };
		seen.add(ref);
		affectedRefs.push(ref);
		if (affectedRefs.length > MAX_AFFECTED_REFS) {
			return { ok: false, error: `Graphite ${operation} dry run affected more than ${MAX_AFFECTED_REFS} branches.` };
		}
	}
	return affectedRefs.length > 0
		? { ok: true, affectedRefs }
		: { ok: false, error: `Graphite ${operation} dry run listed no affected branches.` };
}

export function verifyGraphiteDryRunAffectedRefs(
	raw: string,
	operation: GraphiteDryRunOperation,
	expectedRefs: readonly string[],
): GraphiteDryRunParseResult {
	const parsed = parseGraphiteDryRunAffectedRefs(raw, operation);
	if (!parsed.ok) return parsed;
	if (
		parsed.affectedRefs.length !== expectedRefs.length ||
		parsed.affectedRefs.some((ref, index) => ref !== expectedRefs[index])
	) {
		return {
			ok: false,
			error: `Graphite ${operation} dry run affected [${parsed.affectedRefs.join(", ")}], expected [${expectedRefs.join(", ")}].`,
		};
	}
	return parsed;
}

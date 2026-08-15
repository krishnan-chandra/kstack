/** Shared keyword-extracting slug used for session names, branches, and worktree paths. */

export const MAX_SLUG_LENGTH = 30;

/** Words that carry no identifying weight in a slug. */
const STOP_WORDS = new Set([
	"a",
	"an",
	"the",
	"and",
	"or",
	"but",
	"of",
	"to",
	"in",
	"on",
	"for",
	"with",
	"without",
	"by",
	"at",
	"from",
	"into",
	"over",
	"after",
	"is",
	"are",
	"was",
	"were",
	"be",
	"been",
	"it",
	"its",
	"this",
	"that",
	"these",
	"those",
	"i",
	"we",
	"my",
	"our",
	"us",
	"me",
	"you",
	"your",
	"please",
	"let",
	"lets",
	"can",
	"could",
	"should",
	"would",
	"will",
	"shall",
	"do",
	"does",
	"did",
	"make",
	"need",
	"needs",
	"want",
	"wants",
	"also",
	"just",
	"so",
	"as",
	"if",
	"when",
	"while",
	"not",
	"no",
	"all",
	"every",
	"each",
	"any",
	"some",
	"per",
	"via",
]);

function tokenize(task: string): string[] {
	const firstContentLine =
		task
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? "";
	return firstContentLine
		.replace(/^(?:#{1,6}|[-*+]|>)\s+/, "")
		.replace(/'s\b/gi, "")
		.normalize("NFKD")
		.replace(/(\p{Script=Latin})\p{Mark}+/gu, "$1")
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.filter(Boolean);
}

/**
 * ASCII-safe form of a filesystem name (e.g. a repository basename). Unlike
 * {@link extractSlug}, no stop-word filtering: every word of the real name is
 * identifying, so `my-project` stays `my-project`.
 */
export function normalizePathSegment(name: string, fallback = "repo"): string {
	const segment = name
		.normalize("NFKD")
		.replace(/(\p{Script=Latin})\p{Mark}+/gu, "$1")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return segment || fallback;
}

/**
 * Extract the best short slug from a task: the leading content line reduced to
 * its meaningful keywords, joined toward a {@link MAX_SLUG_LENGTH}-character
 * target. The target is soft: words are never cut mid-word, so a long first
 * keyword stays whole. Deterministic and ASCII-only so the result is safe for
 * Git refs and paths; non-English text is out of scope and falls back.
 */
export function extractSlug(task: string, fallback = "change"): string {
	const tokens = tokenize(task);
	const keywords = tokens.filter((token) => !STOP_WORDS.has(token));
	const words = keywords.length ? keywords : tokens;
	let slug = "";
	for (const word of words) {
		const candidate = slug ? `${slug}-${word}` : word;
		if (slug && candidate.length > MAX_SLUG_LENGTH) break;
		slug = candidate;
	}
	return slug || fallback;
}

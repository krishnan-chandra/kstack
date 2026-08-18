import { CHANGE_KINDS } from "../shared/change-kind.ts";

interface FastImplementCompletionItem {
	value: string;
	label: string;
}

const FLAGS = ["--worktree", "--change-kind"] as const;

/** Split off the token currently being typed from `prefix`, preserving exact leading text. */
function splitCurrentToken(prefix: string): { leading: string; current: string } {
	if (prefix === "" || /\s$/.test(prefix)) return { leading: prefix, current: "" };
	const match = /^([\s\S]*?)(\S+)$/.exec(prefix);
	return match ? { leading: match[1], current: match[2] } : { leading: "", current: prefix };
}

/**
 * Pure argument-completion helper for `/fast-implement`.
 *
 * Completes the finite flags `--worktree` and `--change-kind <kind>` while a
 * command line still consists only of flags. Once free-form task text
 * appears, this returns `null` so the task itself is never guessed at. When
 * completing `--change-kind`'s value, or a later flag, any preceding flag
 * text is preserved verbatim in the returned replacement.
 */
export function getArgumentCompletions(argumentPrefix: string): FastImplementCompletionItem[] | null {
	const { leading, current } = splitCurrentToken(argumentPrefix);
	const priorTokens = leading.trim() ? leading.trim().split(/\s+/) : [];

	// Value position immediately after a bare `--change-kind` token.
	if (priorTokens.at(-1) === "--change-kind") {
		return CHANGE_KINDS.filter((kind) => kind.startsWith(current)).map((kind) => ({
			value: `${leading}${kind} `,
			label: kind,
		}));
	}

	// Walk prior tokens; bail (free-form task text) as soon as one isn't a
	// recognized flag or change-kind value in a valid position.
	let sawWorktree = false;
	let sawChangeKind = false;
	for (let i = 0; i < priorTokens.length; i++) {
		const token = priorTokens[i];
		if (token === "--worktree" && !sawWorktree) {
			sawWorktree = true;
			continue;
		}
		if (token === "--change-kind" && !sawChangeKind) {
			const value = priorTokens[i + 1];
			if (value === undefined || !CHANGE_KINDS.includes(value as (typeof CHANGE_KINDS)[number])) return null;
			sawChangeKind = true;
			i++;
			continue;
		}
		return null;
	}

	if (current !== "" && !current.startsWith("--")) return null;

	const candidates = FLAGS.filter(
		(flag) => !(flag === "--worktree" && sawWorktree) && !(flag === "--change-kind" && sawChangeKind),
	);
	const matches = candidates.filter((flag) => flag.startsWith(current));
	if (matches.length === 0) return null;
	return matches.map((flag) => ({ value: `${leading}${flag} `, label: flag }));
}

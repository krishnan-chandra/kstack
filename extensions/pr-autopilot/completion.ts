/**
 * Argument autocomplete for `/pr-autopilot [--mode check|threads|drive|watch|cleanup] [--pr <number>]`.
 *
 * `--mode` has a finite set of values, so the completer offers them once the
 * cursor is positioned at that value. `--pr` takes an arbitrary PR number that
 * this extension has no business guessing, so it completes only as a bare
 * flag and never suggests a value.
 */

const MODES = ["check", "threads", "drive", "watch", "cleanup"] as const;
const FLAGS = ["--mode", "--pr"] as const;

/** Complete `/pr-autopilot` arguments, preserving any text before the token being completed. */
export function getArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null {
	let tokenStart = prefix.length;
	while (tokenStart > 0) {
		const character = prefix[tokenStart - 1];
		if (character === undefined || /\s/.test(character)) break;
		tokenStart--;
	}
	const base = prefix.slice(0, tokenStart);
	const token = prefix.slice(tokenStart);
	const previousToken = base.trimEnd().split(/\s+/).at(-1);

	// Waiting for a --mode value: offer the finite mode set.
	if (previousToken === "--mode") {
		return listOrNull(
			MODES.filter((mode) => mode.startsWith(token)).map((mode) => ({ value: `${base}${mode}`, label: mode })),
		);
	}

	// Waiting for a --pr value: the PR number is not ours to guess.
	if (previousToken === "--pr") return null;

	const items = FLAGS.filter((flag) => flag.startsWith(token)).map((flag) => ({
		value: `${base}${flag}`,
		label: flag,
	}));
	return listOrNull(items);
}

function listOrNull<T>(items: T[]): T[] | null {
	return items.length > 0 ? items : null;
}

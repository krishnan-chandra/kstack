/**
 * Safe panel-review argument formatting.
 *
 * Round-trips structured base/intent values through the existing parser,
 * handling quotes, backslashes, newlines, and flag-looking text so callers
 * (plan-implement, kstack-router) never interpolate raw user text.
 */

const INTENT_CHARS = 1000;

/**
 * Escape a string value for use as a `--intent` or `--base` argument.
 *
 * Backslashes are preserved (double-escaped in JSON/Pi context), embedded
 * double quotes are escaped, and newlines are replaced with spaces.
 * The value is then wrapped in double quotes.
 */
export function formatPanelArg(value: string): string {
	const sanitized = value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, " ")
		.replace(/\r/g, " ")
		.replace(/\t/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return `"${sanitized}"`;
}

/**
 * Build a full panel-review argument string with an intent and optional base.
 *
 * The intent is bounded to INTENT_CHARS to avoid overwhelming the parser or
 * creating oversized temp bundles. The base ref is validated as a non-empty
 * string containing only safe characters (alphanumeric, dashes, slashes,
 * dots, underscores).
 */
export function buildPanelArgs(options: {
	intent: string;
	base?: string;
}): { ok: true; args: string } | { ok: false; error: string } {
	const trimmed = options.intent.trim();
	if (!trimmed) return { ok: false, error: "panel review intent must be non-empty." };

	const bounded = Array.from(trimmed).slice(0, INTENT_CHARS).join("");
	const intentArg = `--intent ${formatPanelArg(bounded)}`;

	if (options.base !== undefined) {
		const base = options.base.trim();
		if (!base) return { ok: false, error: "panel review base must be non-empty when provided." };
		if (!/^[a-zA-Z0-9\-_./]+$/.test(base)) {
			return { ok: false, error: "panel review base contains unsafe characters." };
		}
		return { ok: true, args: `--base ${formatPanelArg(base)} ${intentArg}` };
	}

	return { ok: true, args: intentArg };
}
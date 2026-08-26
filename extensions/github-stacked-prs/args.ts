/** `/gh-stack` argument parsing and completion. */

import { isSafeStackRef } from "../shared/stack/manifest.ts";

interface GitHubStackPublishArgs {
	action: "publish";
	top: string;
	remote: string;
	ready: boolean;
}

const FLAGS = ["--top", "--remote", "--ready"] as const;
const FLAG_SET: ReadonlySet<string> = new Set(FLAGS);

export function parseGitHubStackArgs(
	text: string,
): { ok: true; command: GitHubStackPublishArgs } | { ok: false; error: string } {
	const usage = "Usage: /gh-stack publish --top <branch> [--remote origin] [--ready]";
	const tokens = text.trim() ? text.trim().split(/\s+/) : [];
	if (tokens[0] !== "publish") return { ok: false, error: usage };
	const values = new Map<string, string>();
	for (let index = 1; index < tokens.length; index++) {
		const flag = tokens[index];
		if (!FLAG_SET.has(flag)) return { ok: false, error: `Unknown option: ${flag}. ${usage}` };
		if (values.has(flag)) return { ok: false, error: `Duplicate option: ${flag}.` };
		if (flag === "--ready") {
			values.set(flag, "true");
			continue;
		}
		const value = tokens[++index];
		if (!value || value.startsWith("--")) return { ok: false, error: `Missing value for ${flag}.` };
		values.set(flag, value);
	}
	const top = values.get("--top");
	if (!top) return { ok: false, error: `publish requires --top. ${usage}` };
	if (!isSafeStackRef(top, true)) return { ok: false, error: "--top must name a local kstack/ branch." };
	const remote = values.get("--remote") ?? "origin";
	if (!isSafeStackRef(remote)) return { ok: false, error: "Invalid --remote name." };
	return { ok: true, command: { action: "publish", top, remote, ready: values.has("--ready") } };
}

export function completeGitHubStackArgs(prefix: string): Array<{ value: string; label: string }> | null {
	let tokenStart = prefix.length;
	while (tokenStart > 0 && !/\s/.test(prefix[tokenStart - 1] ?? "")) tokenStart--;
	const base = prefix.slice(0, tokenStart);
	const token = prefix.slice(tokenStart);
	const prior = base.trim() ? base.trim().split(/\s+/) : [];
	if (prior.length === 0) {
		return "publish".startsWith(token) ? [{ value: `${base}publish`, label: "publish" }] : null;
	}
	if (prior[0] !== "publish") return null;
	const previous = prior.at(-1);
	if (previous === "--top" || previous === "--remote") return null;
	if (token && !token.startsWith("--")) return null;
	const items = FLAGS.filter((flag) => flag.startsWith(token)).map((flag) => ({
		value: `${base}${flag}`,
		label: flag,
	}));
	return items.length > 0 ? items : null;
}

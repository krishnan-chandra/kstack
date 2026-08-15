import type { ExtensionAPI, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";

interface CommandFallthrough {
	command: string;
	args: string;
}

/**
 * Match extension-command input that reached `input` because Pi only splits
 * command names at a literal space. The caller decides whether to reroute or
 * block the invocation.
 */
export function matchCommandFallthrough(text: string, commands: ReadonlySet<string>): CommandFallthrough | undefined {
	if (!text.startsWith("/")) return undefined;

	const newline = text.indexOf("\n");
	if (newline < 0) return undefined;

	const command = text.slice(1, newline).trimEnd();
	if (!commands.has(command)) return undefined;

	return { command, args: text.slice(newline + 1).trimStart() };
}

export function commandFallthroughResult(
	event: Pick<InputEvent, "source" | "text">,
	commands: ReadonlySet<string>,
	notify: (message: string, level: "error") => void,
): InputEventResult {
	if (event.source === "extension") return { action: "continue" };

	const matched = matchCommandFallthrough(event.text, commands);
	if (!matched) return { action: "continue" };

	notify(
		`/${matched.command} was not run because Pi dispatches extension commands only when the name is followed by a literal space. Retry as /${matched.command} ${matched.args || "<arguments>"}`,
		"error",
	);
	return { action: "handled" };
}

/**
 * Block guarded commands that would otherwise become an unguarded model prompt.
 *
 * Call this exactly once from each extension factory invocation. Pi owns the
 * listener for that extension load; registering it again adds a duplicate
 * `input` listener. Interactive and RPC fallthrough are both blocked. Only
 * extension-injected input bypasses the guard to avoid intercepting trusted
 * extension-to-extension dispatch.
 */
export function guardCommandFallthrough(pi: ExtensionAPI, ...commands: string[]): void {
	const known = new Set(commands);
	pi.on("input", (event, ctx) => commandFallthroughResult(event, known, ctx.ui.notify.bind(ctx.ui)));
}

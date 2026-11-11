/** What a hosted Pi agent runs: its spec, Pi argv, and name rules. */

import { KSTACK_ENTRY } from "../child-agent-runner.ts";

export interface HostedAgentSpec {
	/** Role label; becomes part of the agent name: <owner>-<role>-<4 hex>. */
	role: string;
	/**
	 * Use this agent name verbatim instead of <owner>-<role>-<4 hex>. A name
	 * conflict is a start failure, never retried under another name.
	 */
	exactName?: string;
	/** Pi model reference in provider/model[:thinking] form. */
	model: string;
	cwd: string;
	/** `--tools` allowlist; undefined = Pi defaults. */
	tools?: readonly string[];
	/**
	 * Enable normal Pi extension discovery instead of `--no-extensions`.
	 * Discovery uses the child's cwd and trust state; it does not transfer
	 * parent-only CLI extensions or runtime registrations. Default false.
	 */
	inheritExtensions?: boolean;
	/** Repeated `--append-system-prompt`. */
	systemPromptFiles?: readonly string[];
	/** Repeated `--skill` (implies `--no-skills`). */
	skillPaths?: readonly string[];
	noSkills?: boolean;
	noContextFiles?: boolean;
	/** Pi `--name` for the session. */
	sessionName?: string;
	/** Optional persistent sidecar state-file path (defaults inside exchangeDir). */
	stateFile?: string;
	/** Interactive-readiness timeout in ms, 3_000..300_000 (default 30_000). */
	startupTimeoutMs?: number;
	/**
	 * Cancels queued pane allocation and startup. When it fires, no agent is
	 * launched and any pane the host split off is closed again.
	 */
	signal?: AbortSignal;
}

/** Build the Pi argv for one hosted agent. No `--mode json`, no `-p`, no
 * `--session-dir`: the session lands in Pi's normal directory and is visible
 * to `/resume` and session-archive. */
export function hostedAgentArgs(spec: HostedAgentSpec, extraPiArgs: readonly string[] = []): string[] {
	const args: string[] = [];
	// The explicit entries survive `--no-extensions` and dedupe with package
	// discovery when that flag is absent, so they are always safe to pass.
	if (!spec.inheritExtensions) args.push("--no-extensions");
	args.push("-e", KSTACK_ENTRY, ...extraPiArgs, "--no-prompt-templates");
	if (spec.skillPaths && spec.skillPaths.length > 0) {
		args.push("--no-skills");
		for (const path of spec.skillPaths) args.push("--skill", path);
	} else if (spec.noSkills) {
		args.push("--no-skills");
	}
	if (spec.noContextFiles) args.push("--no-context-files");
	if (spec.tools !== undefined) {
		if (spec.tools.length === 0) args.push("--no-tools");
		else args.push("--tools", spec.tools.join(","));
	}
	args.push("--model", spec.model);
	for (const path of spec.systemPromptFiles ?? []) args.push("--append-system-prompt", path);
	args.push(
		"--append-system-prompt",
		"For a hosted request, put the requested KSTACK_RESPONSE acknowledgement on the first line of your final reply, then the complete answer. Role-specific output formats apply to the answer after that line. The host saves the reply; no response-writing tool is needed.",
	);
	if (spec.sessionName) args.push("--name", spec.sessionName);
	return args;
}

/** Agent names match [a-z][a-z0-9_-]{0,31}. */
const AGENT_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export function isValidAgentName(name: string): boolean {
	return AGENT_NAME_RE.test(name);
}

/** Agent names must match [a-z][a-z0-9_-]{0,31}. */
export function buildAgentName(owner: string, role: string, suffix: string): string {
	let ownerPart = sanitizeNamePart(owner, 31);
	let rolePart = sanitizeNamePart(role, 31);
	const overflow = ownerPart.length + 1 + rolePart.length + 1 + suffix.length - 32;
	if (overflow > 0) {
		rolePart = rolePart.slice(0, Math.max(1, rolePart.length - overflow));
		const overflow2 = ownerPart.length + 1 + rolePart.length + 1 + suffix.length - 32;
		if (overflow2 > 0) ownerPart = ownerPart.slice(0, Math.max(1, ownerPart.length - overflow2));
	}
	return `${ownerPart}-${rolePart}-${suffix}`;
}

/** A fresh `<owner>-<role>-<4 hex>` name for each start attempt. */
export function randomAgentName(owner: string, role: string): string {
	const suffix = Math.floor(Math.random() * 0xffff)
		.toString(16)
		.padStart(4, "0");
	return buildAgentName(owner, role, suffix);
}

function sanitizeNamePart(value: string, max: number): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	const withLetterPrefix = /^[a-z]/.test(sanitized) ? sanitized : `a-${sanitized || "agent"}`;
	return withLetterPrefix.slice(0, max).replace(/-+$/g, "");
}

import { isChangeKind, type ChangeKind } from "../shared/change-kind.ts";
import { LIMITS, type FastImplementRequest } from "./types.ts";

export function validateTask(raw: string): { ok: true; task: string } | { ok: false; error: string } {
	const task = raw.trim();
	if (!task) return { ok: false, error: "/fast-implement requires a non-empty task." };
	if (Buffer.byteLength(task) > LIMITS.maxTaskBytes) return { ok: false, error: `Task exceeds ${LIMITS.maxTaskBytes} bytes.` };
	return { ok: true, task };
}

/** Split one leading whitespace-delimited token off `input`. */
function takeToken(input: string): { token: string; rest: string } | undefined {
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(input.trim());
	return match ? { token: match[1], rest: match[2] ?? "" } : undefined;
}

export function parseFastImplementArgs(raw: string): { ok: true; request: FastImplementRequest } | { ok: false; error: string } {
	let rest = raw.trim();
	let workLocation: FastImplementRequest["workLocation"] = "current";
	let changeKind: ChangeKind = "generic";
	// Consume leading flags, then treat the raw remainder as the task so that
	// quotes, apostrophes, and contractions inside the task survive verbatim.
	for (let next = takeToken(rest); next?.token.startsWith("--"); next = takeToken(rest)) {
		const { token } = next;
		rest = next.rest;
		if (token === "--") break;
		if (token === "--worktree") { if (workLocation === "worktree") return { ok: false, error: "Duplicate --worktree flag." }; workLocation = "worktree"; continue; }
		if (token === "--change-kind") {
			const valueToken = takeToken(rest);
			const value = valueToken?.token.replace(/^["']|["']$/g, "");
			if (!value || !isChangeKind(value)) return { ok: false, error: "--change-kind requires a supported change kind." };
			changeKind = value; rest = valueToken?.rest ?? ""; continue;
		}
		return { ok: false, error: `Unknown fast-implement flag: ${token}.` };
	}
	const task = rest.trim();
	const unquoted = /^(["'])([\s\S]*)\1$/.exec(task);
	const validated = validateTask(unquoted ? unquoted[2] : task);
	return validated.ok ? { ok: true, request: { task: validated.task, workLocation, changeKind } } : validated;
}

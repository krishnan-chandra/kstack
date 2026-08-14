import { isChangeKind, type ChangeKind } from "../shared/change-kind.ts";
import { LIMITS, type FastImplementRequest } from "./types.ts";

export function validateTask(raw: string): { ok: true; task: string } | { ok: false; error: string } {
	const task = raw.trim();
	if (!task) return { ok: false, error: "/fast-implement requires a non-empty task." };
	if (Buffer.byteLength(task) > LIMITS.maxTaskBytes) return { ok: false, error: `Task exceeds ${LIMITS.maxTaskBytes} bytes.` };
	return { ok: true, task };
}

export function parseFastImplementArgs(raw: string): { ok: true; request: FastImplementRequest } | { ok: false; error: string } {
	const tokens = raw.match(/(?:[^\s"']|"[^"]*"|'[^']*')+/g) ?? [];
	let workLocation: FastImplementRequest["workLocation"] = "current";
	let changeKind: ChangeKind = "generic";
	let taskStart = 0;
	for (; taskStart < tokens.length; taskStart++) {
		const token = tokens[taskStart];
		if (token === "--") { taskStart++; break; }
		if (token === "--worktree") { if (workLocation === "worktree") return { ok: false, error: "Duplicate --worktree flag." }; workLocation = "worktree"; continue; }
		if (token === "--change-kind") {
			const value = tokens[++taskStart];
			if (!value || !isChangeKind(value)) return { ok: false, error: "--change-kind requires a supported change kind." };
			changeKind = value; continue;
		}
		if (token.startsWith("--")) return { ok: false, error: `Unknown fast-implement flag: ${token}.` };
		break;
	}
	const validated = validateTask(tokens.slice(taskStart).join(" ").replace(/^("|')|("|')$/g, ""));
	return validated.ok ? { ok: true, request: { task: validated.task, workLocation, changeKind } } : validated;
}

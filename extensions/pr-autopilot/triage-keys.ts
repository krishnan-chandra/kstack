import { parsePositiveInteger } from "../shared/config-validate.ts";
import type { CheckRun, PRState, ReviewThread } from "./types.ts";

const CHECK_KEY_RE = /^check-([1-9]\d*)$/;
const THREAD_KEY_RE = /^thread-([1-9]\d*)$/;

export type CheckTriageKey = `check-${number}`;
export type ThreadTriageKey = `thread-${number}`;

export function checkTriageKey(index: number): CheckTriageKey {
	return `check-${index + 1}`;
}

export function threadTriageKey(index: number): ThreadTriageKey {
	return `thread-${index + 1}`;
}

export function isCheckTriageKey(value: string): value is CheckTriageKey {
	return keyIndex(value, CHECK_KEY_RE) !== undefined;
}

export function isThreadTriageKey(value: string): value is ThreadTriageKey {
	return keyIndex(value, THREAD_KEY_RE) !== undefined;
}

function keyIndex(key: string, pattern: RegExp): number | undefined {
	const match = pattern.exec(key);
	const oneBased = parsePositiveInteger(match?.[1]);
	return oneBased === undefined ? undefined : oneBased - 1;
}

export function checkForTriageKey(state: PRState, key: CheckTriageKey): CheckRun | undefined {
	const index = keyIndex(key, CHECK_KEY_RE);
	return index === undefined ? undefined : state.checks[index];
}

export function threadForTriageKey(state: PRState, key: ThreadTriageKey): ReviewThread | undefined {
	const index = keyIndex(key, THREAD_KEY_RE);
	return index === undefined ? undefined : state.threads[index];
}

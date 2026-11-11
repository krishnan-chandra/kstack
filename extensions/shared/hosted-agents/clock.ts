/** Time source for polling and retry delays, injectable so tests never wait in real time. */

import { setTimeout as delay } from "node:timers/promises";

export interface Clock {
	now(): number;
	/** Resolve after `ms`, or early when `signal` aborts; never rejects. */
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
	now: () => Date.now(),
	async sleep(ms, signal) {
		if (ms <= 0 || signal?.aborted) return;
		try {
			await delay(ms, undefined, signal ? { signal } : undefined);
		} catch {
			/* woken early by the abort signal */
		}
	},
};

/** A clock whose time advances only when something sleeps. */
export function virtualClock(onSleep?: (ms: number) => void | Promise<void>): Clock {
	let now = Date.now();
	return {
		now: () => now,
		async sleep(ms, signal) {
			if (ms <= 0 || signal?.aborted) return;
			now += ms;
			await onSleep?.(ms);
		},
	};
}

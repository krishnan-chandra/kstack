/** Combine session, command-context, and caller abort signals. */

export function combinePublicationSignals(
	session: AbortSignal,
	ctxSignal?: AbortSignal,
	inputSignal?: AbortSignal,
): AbortSignal {
	const extras = [ctxSignal, inputSignal].filter((signal): signal is AbortSignal => signal !== undefined);
	if (extras.length === 0) return session;
	if (typeof AbortSignal.any === "function") return AbortSignal.any([session, ...extras]);
	const merged = new AbortController();
	const abort = () => merged.abort();
	if (session.aborted || extras.some((signal) => signal.aborted)) merged.abort();
	else {
		session.addEventListener("abort", abort, { once: true });
		for (const extra of extras) extra.addEventListener("abort", abort, { once: true });
	}
	return merged.signal;
}

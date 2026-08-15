/** Combine session, command-context, and caller abort signals. */

export function combinePublicationSignals(session: AbortSignal, ctxSignal?: AbortSignal): AbortSignal {
	return ctxSignal ? AbortSignal.any([session, ctxSignal]) : session;
}

/** Own review-pane acquisition, including hosts that arrive after cancellation. */
import type { AgentHost, HostDeps, openPaneHost } from "./agent-host.ts";

export function createPaneAcquisitionOwner(deps: { openPane: typeof openPaneHost; hostDeps: () => HostDeps }) {
	type OpenResult = Awaited<ReturnType<typeof openPaneHost>>;
	const hosts = new Map<AgentHost, Promise<void> | undefined>();
	const pending = new Map<Promise<void>, () => void>();
	const cleanupErrors: unknown[] = [];
	let completion: Promise<void> | undefined;

	const cleanup = (host: AgentHost, closeTab: boolean): void => {
		if (hosts.get(host)) return;
		const task = Promise.resolve().then(async () => {
			try {
				await host.dispose(closeTab ? { closeTab: true } : undefined);
			} catch (error) {
				cleanupErrors.push(error);
			}
		});
		hosts.set(host, task);
	};

	return {
		acquire(options: Parameters<typeof openPaneHost>[0], signal: AbortSignal): Promise<OpenResult> {
			if (completion || signal.aborted)
				return Promise.resolve({
					ok: false,
					error: "Pane acquisition cancelled before the review deadline (or owner disposed).",
				});
			return new Promise<OpenResult>((resolve) => {
				let settled = false;
				const settle = (result: OpenResult) => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", cancel);
					resolve(result);
				};
				const cancel = () =>
					settle({ ok: false, error: "Pane acquisition cancelled at the review deadline or during disposal." });
				signal.addEventListener("abort", cancel, { once: true });
				// Do not pass the round signal to the opener: interrupting a split can
				// lose acceptance evidence. Keep its bounded control calls joinable.
				const task = Promise.resolve()
					.then(() => deps.openPane(options, deps.hostDeps()))
					.then(
						(result) => {
							if (result.ok) {
								hosts.set(result.host, undefined);
								if (settled) cleanup(result.host, true);
							}
							settle(result);
						},
						// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Promise rejections are an untyped external boundary.
						(error: unknown) => {
							// Cancellation has already returned to the caller. Preserve a late
							// construction/rollback failure for disposal instead of losing it.
							if (settled) cleanupErrors.push(error);
							settle({
								ok: false,
								error: `Could not acquire the review pane: ${error instanceof Error ? error.message : String(error)}`,
							});
						},
					);
				pending.set(task, cancel);
				void task.then(() => pending.delete(task));
			});
		},
		discard(host: AgentHost): void {
			if (!hosts.has(host)) throw new Error("Cannot discard a pane host not acquired by this owner.");
			cleanup(host, true);
		},
		dispose(): Promise<void> {
			if (completion) return completion;
			for (const cancel of pending.values()) cancel();
			completion = (async () => {
				await Promise.all(pending.keys());
				for (const host of hosts.keys()) cleanup(host, false);
				await Promise.all(hosts.values());
				if (cleanupErrors.length)
					throw new AggregateError(
						cleanupErrors,
						`Review pane cleanup failed: ${cleanupErrors.map((error) => (error instanceof Error ? error.message : String(error))).join("; ")}`,
					);
			})();
			return completion;
		},
	};
}

/** Session-aware lifecycle for one kstack-router operation. */

import { SessionLifecycle, type SessionToken } from "../shared/session-lifecycle.ts";
import type { RouteId } from "./types.ts";

export interface DispatchToken extends SessionToken {
	readonly dispatchId: string;
}
interface ActiveDispatch {
	readonly token: DispatchToken;
	readonly route: RouteId;
}
interface ToolSnapshot {
	tools: string[];
}

export class RouterLifecycle extends SessionLifecycle {
	private dispatchIdCounter = 0;
	private currentDispatch: DispatchToken | undefined;
	private currentRoute: RouteId | undefined;
	private toolSnapshot: ToolSnapshot | undefined;
	private classifier: AbortController | undefined;

	sessionToken(): SessionToken | undefined {
		return this.currentSessionToken();
	}

	beginClassifier(token: SessionToken): AbortController | undefined {
		if (!this.isSessionCurrent(token) || this.classifier || this.currentDispatch) return undefined;
		this.classifier = new AbortController();
		return this.classifier;
	}

	endClassifier(token: SessionToken): void {
		if (this.isSessionCurrent(token)) this.classifier = undefined;
	}

	abortClassifier(): boolean {
		if (!this.classifier || this.classifier.signal.aborted) return false;
		this.classifier.abort();
		return true;
	}

	beginDispatch(token: SessionToken, options: { route: RouteId; toolSnapshot?: string[] }): DispatchToken | undefined {
		if (!this.isSessionCurrent(token) || this.currentDispatch || this.classifier) return undefined;
		const dispatch: DispatchToken = {
			generation: token.generation,
			dispatchId: `dispatch-${++this.dispatchIdCounter}`,
		};
		this.currentDispatch = dispatch;
		this.currentRoute = options.route;
		this.toolSnapshot = options.toolSnapshot ? { tools: [...options.toolSnapshot] } : undefined;
		return dispatch;
	}

	getActiveDispatch(): ActiveDispatch | undefined {
		return this.currentDispatch && this.currentRoute
			? { token: this.currentDispatch, route: this.currentRoute }
			: undefined;
	}

	getToolSnapshot(): ToolSnapshot | undefined {
		return this.toolSnapshot;
	}

	isCurrentDispatch(dispatch: DispatchToken): boolean {
		const current = this.currentDispatch;
		return current?.dispatchId === dispatch.dispatchId && current.generation === dispatch.generation;
	}

	endDispatch(dispatch: DispatchToken): void {
		if (!this.isCurrentDispatch(dispatch)) return;
		this.clearDispatch();
	}

	protected override onStart(): void {
		this.classifier?.abort();
		this.classifier = undefined;
		this.clearDispatch();
	}

	protected override onShutdown(): void {
		this.classifier?.abort();
		this.classifier = undefined;
		this.clearDispatch();
	}

	private clearDispatch(): void {
		this.currentDispatch = undefined;
		this.currentRoute = undefined;
		this.toolSnapshot = undefined;
	}
}

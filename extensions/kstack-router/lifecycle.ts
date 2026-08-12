/** Session-aware lifecycle for one kstack-router operation. */

import type { RouteId } from "./types.ts";

export interface DispatchToken {
	readonly generation: number;
	readonly dispatchId: string;
}

export interface ActiveDispatch {
	readonly token: DispatchToken;
	readonly route: RouteId;
}

export interface ToolSnapshot {
	tools: string[];
}

export class RouterLifecycle {
	private generation = 0;
	private sessionActive = false;
	private dispatchIdCounter = 0;
	private currentDispatch: DispatchToken | undefined;
	private currentRoute: RouteId | undefined;
	private toolSnapshot: ToolSnapshot | undefined;
	private classifier: AbortController | undefined;

	startSession(): void {
		this.generation++;
		this.sessionActive = true;
		this.currentDispatch = undefined;
		this.currentRoute = undefined;
		this.toolSnapshot = undefined;
		this.classifier = undefined;
	}

	shutdownSession(): void {
		this.sessionActive = false;
		this.generation++;
		this.classifier?.abort();
		this.classifier = undefined;
		this.currentDispatch = undefined;
		this.currentRoute = undefined;
		this.toolSnapshot = undefined;
	}

	sessionToken(): { generation: number } | undefined {
		return this.sessionActive ? { generation: this.generation } : undefined;
	}

	isSessionCurrent(token: { generation: number }): boolean {
		return this.sessionActive && token.generation === this.generation;
	}

	beginClassifier(token: { generation: number }): AbortController | undefined {
		if (!this.isSessionCurrent(token) || this.classifier || this.currentDispatch) return undefined;
		this.classifier = new AbortController();
		return this.classifier;
	}

	endClassifier(token: { generation: number }): void {
		if (this.isSessionCurrent(token)) this.classifier = undefined;
	}

	abortClassifier(): boolean {
		if (!this.classifier || this.classifier.signal.aborted) return false;
		this.classifier.abort();
		return true;
	}

	beginDispatch(
		token: { generation: number },
		options: { route: RouteId; toolSnapshot?: string[] },
	): DispatchToken | undefined {
		if (!this.isSessionCurrent(token) || this.currentDispatch || this.classifier) return undefined;
		const dispatch: DispatchToken = {
			generation: this.generation,
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
		this.currentDispatch = undefined;
		this.currentRoute = undefined;
		this.toolSnapshot = undefined;
	}
}

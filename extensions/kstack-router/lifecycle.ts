/** Session-aware lifecycle for one kstack-router dispatch. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface DispatchToken {
	readonly generation: number;
	readonly dispatchId: string;
}

export interface ToolSnapshot {
	tools: string[];
}

export class RouterLifecycle {
	private generation = 0;
	private sessionActive = false;
	private dispatchIdCounter = 0;
	private currentDispatch: DispatchToken | undefined;
	private toolSnapshot: ToolSnapshot | undefined;
	private abortController: AbortController | undefined;
	private activeClassifier = false;

	startSession(): void {
		this.generation++;
		this.sessionActive = true;
		this.currentDispatch = undefined;
		this.toolSnapshot = undefined;
		this.abortController = undefined;
		this.activeClassifier = false;
	}

	shutdownSession(): void {
		this.sessionActive = false;
		this.generation++;
		this.abortController?.abort();
		this.abortController = undefined;
		this.currentDispatch = undefined;
		this.toolSnapshot = undefined;
		this.activeClassifier = false;
	}

	sessionToken(): { generation: number } | undefined {
		return this.sessionActive ? { generation: this.generation } : undefined;
	}

	isSessionCurrent(token: { generation: number }): boolean {
		return this.sessionActive && token.generation === this.generation;
	}

	/** Begin a classifier run. Returns an abort controller for Ctrl+Shift+K. */
	beginClassifier(token: { generation: number }): AbortController | undefined {
		if (!this.isSessionCurrent(token) || this.activeClassifier) return undefined;
		this.activeClassifier = true;
		const controller = new AbortController();
		this.abortController = controller;
		return controller;
	}

	endClassifier(token: { generation: number }): void {
		if (!this.isSessionCurrent(token)) return;
		this.activeClassifier = false;
		if (this.abortController && !this.abortController.signal.aborted) {
			// Don't clear the controller if it's for a dispatch.
		} else {
			this.abortController = undefined;
		}
	}

	/** Abort the active classifier (Ctrl+Shift+K). */
	abortClassifier(): boolean {
		if (!this.activeClassifier || !this.abortController || this.abortController.signal.aborted) return false;
		this.abortController.abort();
		return true;
	}

	/** Begin a dispatch. Creates a unique dispatch ID and captures the current tools. */
	beginDispatch(
		token: { generation: number },
		pi: ExtensionAPI,
	): DispatchToken | undefined {
		if (!this.isSessionCurrent(token) || this.currentDispatch) return undefined;
		this.dispatchIdCounter++;
		const dispatch: DispatchToken = {
			generation: this.generation,
			dispatchId: `dispatch-${this.dispatchIdCounter}`,
		};
		this.currentDispatch = dispatch;

		// Capture the current tool set.
		this.toolSnapshot = { tools: pi.getTools()?.map((t) => t.name) ?? [] };
		this.activeClassifier = false;
		this.abortController = undefined;

		return dispatch;
	}

	/** Get the captured tool snapshot for the current dispatch. */
	getToolSnapshot(): ToolSnapshot | undefined {
		return this.toolSnapshot;
	}

	isCurrentDispatch(dispatch: DispatchToken): boolean {
		return (
			this.currentDispatch !== undefined &&
			this.currentDispatch.dispatchId === dispatch.dispatchId &&
			this.currentDispatch.generation === dispatch.generation
		);
	}

	endDispatch(dispatch: DispatchToken): void {
		if (!this.isCurrentDispatch(dispatch)) return;
		this.currentDispatch = undefined;
		this.toolSnapshot = undefined;
		this.abortController = undefined;
	}
}
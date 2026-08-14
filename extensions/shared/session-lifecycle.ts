/** Token minted for one active session generation. */
export interface SessionToken {
	readonly generation: number;
}

/**
 * Generation-counted session state shared by extension lifecycles.
 *
 * Subclasses add operation-specific state through hooks. Shutdown invalidates
 * the generation before invoking the hook, so abort callbacks cannot observe a
 * stale token as current.
 */
export class SessionLifecycle {
	private generation = 0;
	private sessionActive = false;

	startSession(): void {
		this.generation++;
		this.sessionActive = true;
		this.onStart();
	}

	shutdownSession(): void {
		this.sessionActive = false;
		this.generation++;
		this.onShutdown();
	}

	currentSessionToken(): SessionToken | undefined {
		return this.sessionActive ? { generation: this.generation } : undefined;
	}

	isSessionCurrent(token: SessionToken): boolean {
		return this.sessionActive && token.generation === this.generation;
	}

	protected onStart(): void {}
	protected onShutdown(): void {}
}

/** Generation-counted session guard allowing at most one active run. */
export class SessionRunLifecycle extends SessionLifecycle {
	private running = false;

	beginRun(token: SessionToken): SessionToken | undefined {
		if (this.running || !this.isSessionCurrent(token)) return undefined;
		this.running = true;
		return this.currentSessionToken();
	}

	endRun(token: SessionToken): void {
		if (this.isSessionCurrent(token)) this.running = false;
	}

	isRunning(): boolean {
		return this.running;
	}

	isCurrent(token: SessionToken): boolean {
		return this.running && this.isSessionCurrent(token);
	}

	protected override onStart(): void {
		this.running = false;
	}

	protected override onShutdown(): void {
		this.running = false;
	}
}

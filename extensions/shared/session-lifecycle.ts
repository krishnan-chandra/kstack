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

/** Generation-counted session guard allowing at most one abortable run. */
export class SessionRunLifecycle extends SessionLifecycle {
	private running = false;
	private controller: AbortController | undefined;

	beginRun(token: SessionToken): SessionToken | undefined {
		if (this.running || !this.isSessionCurrent(token)) return undefined;
		this.running = true;
		this.controller = new AbortController();
		return this.currentSessionToken();
	}

	/** Return the active run's signal when the token is current. */
	runSignal(token: SessionToken): AbortSignal | undefined {
		return this.isCurrent(token) ? this.controller?.signal : undefined;
	}

	/**
	 * Start a fresh abortable phase after all work using the previous phase's
	 * signal has settled. The previous signal is left unchanged so cancellation
	 * remains observable as belonging to that completed phase.
	 */
	beginNextPhase(token: SessionToken): AbortSignal | undefined {
		if (!this.isCurrent(token)) return undefined;
		this.controller = new AbortController();
		return this.controller.signal;
	}

	/** Abort the active run phase. Returns false when no phase can be aborted. */
	abortRun(): boolean {
		if (!this.controller || this.controller.signal.aborted) return false;
		this.controller.abort();
		return true;
	}

	endRun(token: SessionToken): void {
		if (!this.isCurrent(token)) return;
		this.running = false;
		this.controller = undefined;
	}

	isRunning(): boolean {
		return this.running;
	}

	isCurrent(token: SessionToken): boolean {
		return this.running && this.isSessionCurrent(token);
	}

	protected override onStart(): void {
		this.controller?.abort();
		this.running = false;
		this.controller = undefined;
	}

	protected override onShutdown(): void {
		this.controller?.abort();
		this.running = false;
		this.controller = undefined;
	}
}

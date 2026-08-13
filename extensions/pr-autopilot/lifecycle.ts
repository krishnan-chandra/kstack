/** Session-aware lifecycle for a pr-autopilot run. */

export interface AutopilotToken {
	readonly generation: number;
}

/**
 * Guards one autopilot run per session. Two autopilot runs on the same stack
 * produce conflicting pushes, so we allow only a single active run and
 * invalidate stale tokens when the session ends or a new run begins.
 */
export class AutopilotLifecycle {
	private generation = 0;
	private sessionActive = false;
	private running = false;

	startSession(): void {
		this.generation++;
		this.sessionActive = true;
		this.running = false;
	}

	shutdownSession(): void {
		this.sessionActive = false;
		this.generation++;
		this.running = false;
	}

	/** Token for the current session, or undefined when no session is active. */
	currentSessionToken(): AutopilotToken | undefined {
		return this.sessionActive ? { generation: this.generation } : undefined;
	}

	isSessionCurrent(token: AutopilotToken): boolean {
		return this.sessionActive && token.generation === this.generation;
	}

	/** Begin an autopilot run; returns a token or undefined if one is already active. */
	beginRun(token: AutopilotToken): AutopilotToken | undefined {
		if (!this.sessionActive || this.running) return undefined;
		if (token.generation !== this.generation) return undefined;
		this.running = true;
		return { generation: this.generation };
	}

	/** End an autopilot run, clearing the active flag. */
	endRun(runToken: AutopilotToken): void {
		if (runToken.generation !== this.generation) return;
		this.running = false;
	}

	isRunning(): boolean {
		return this.running;
	}

	isCurrent(token: AutopilotToken): boolean {
		return this.running && this.isSessionCurrent(token);
	}
}

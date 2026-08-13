/** Session-aware lifecycle for a pr-babysit run. */

export interface BabysitToken {
	readonly generation: number;
}

/**
 * Guards one babysit run per session. Two babysitters on the same stack
 * produce conflicting pushes, so we allow only a single active run and
 * invalidate stale tokens when the session ends or a new run begins.
 */
export class BabysitLifecycle {
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
	currentSessionToken(): BabysitToken | undefined {
		return this.sessionActive ? { generation: this.generation } : undefined;
	}

	isSessionCurrent(token: BabysitToken): boolean {
		return this.sessionActive && token.generation === this.generation;
	}

	/** Begin a babysit run; returns a token or undefined if one is already active. */
	beginRun(token: BabysitToken): BabysitToken | undefined {
		if (!this.sessionActive || this.running) return undefined;
		if (token.generation !== this.generation) return undefined;
		this.running = true;
		return { generation: this.generation };
	}

	/** End a babysit run, clearing the active flag. */
	endRun(runToken: BabysitToken): void {
		if (runToken.generation !== this.generation) return;
		this.running = false;
	}

	isRunning(): boolean {
		return this.running;
	}

	/** Current phase label for status display. */
	currentPhase(): "idle" | "checking" | "triaging" | "fixing" | "pushing" | "cleaning" {
		if (!this.sessionActive) return "idle";
		if (!this.running) return "idle";
		return this.phase;
	}

	private phase: "idle" | "checking" | "triaging" | "fixing" | "pushing" | "cleaning" = "idle";

	setPhase(phase: "idle" | "checking" | "triaging" | "fixing" | "pushing" | "cleaning"): void {
		this.phase = phase;
	}
}

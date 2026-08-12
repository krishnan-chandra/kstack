/** Session-aware, phase-aware state for one plan/implement workflow. */

export type WorkflowPhase = "idle" | "planning" | "approval" | "implementing" | "fixing" | "publishing";
export interface WorkflowToken { readonly generation: number; }

export class WorkflowLifecycle {
	private generation = 0;
	private sessionActive = false;
	private running = false;
	private phase: WorkflowPhase = "idle";
	private childAbort: AbortController | undefined;

	startSession(): void {
		this.generation++;
		this.sessionActive = true;
		this.running = false;
		this.phase = "idle";
		this.childAbort = undefined;
	}

	shutdownSession(): void {
		this.sessionActive = false;
		this.generation++;
		this.childAbort?.abort();
		this.childAbort = undefined;
		this.running = false;
		this.phase = "idle";
	}

	isRunning(): boolean {
		return this.running;
	}

	currentSessionToken(): WorkflowToken | undefined {
		return this.sessionActive ? { generation: this.generation } : undefined;
	}

	beginWorkflow(expectedSession?: WorkflowToken): WorkflowToken | undefined {
		if (!this.sessionActive || this.running) return undefined;
		if (expectedSession && expectedSession.generation !== this.generation) return undefined;
		this.running = true;
		this.phase = "approval";
		return { generation: this.generation };
	}

	isSessionCurrent(token: WorkflowToken): boolean {
		return this.sessionActive && token.generation === this.generation;
	}

	isCurrent(token: WorkflowToken): boolean {
		return this.running && this.isSessionCurrent(token);
	}

	beginChild(token: WorkflowToken, phase: "planning" | "implementing" | "fixing" | "publishing"): AbortController | undefined {
		if (!this.isCurrent(token) || this.childAbort) return undefined;
		const controller = new AbortController();
		this.childAbort = controller;
		this.phase = phase;
		return controller;
	}

	endChild(token: WorkflowToken, controller: AbortController): void {
		if (!this.isCurrent(token) || this.childAbort !== controller) return;
		this.childAbort = undefined;
		this.phase = "approval";
	}

	abortActiveChild(): boolean {
		if (!this.childAbort || this.childAbort.signal.aborted) return false;
		this.childAbort.abort();
		return true;
	}

	finishWorkflow(token: WorkflowToken): void {
		if (token.generation !== this.generation) return;
		this.childAbort?.abort();
		this.childAbort = undefined;
		this.running = false;
		this.phase = "idle";
	}

	currentPhase(): WorkflowPhase {
		return this.phase;
	}
}

/** Session-aware lifecycle for a panel-review run. */

export interface PanelToken {
	readonly generation: number;
}

export class PanelLifecycle {
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

	currentSessionToken(): PanelToken | undefined {
		return this.sessionActive ? { generation: this.generation } : undefined;
	}

	isSessionCurrent(token: PanelToken): boolean {
		return this.sessionActive && token.generation === this.generation;
	}

	beginRun(token: PanelToken): PanelToken | undefined {
		if (!this.sessionActive || this.running || token.generation !== this.generation) return undefined;
		this.running = true;
		return { generation: this.generation };
	}

	endRun(token: PanelToken): void {
		if (token.generation === this.generation) this.running = false;
	}

	isRunning(): boolean {
		return this.running;
	}

	isCurrent(token: PanelToken): boolean {
		return this.running && this.isSessionCurrent(token);
	}
}

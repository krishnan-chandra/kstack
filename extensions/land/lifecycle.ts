export class LandLifecycle {
	private generation = 0; private running = false; private controller?: AbortController;
	startSession(): void { this.generation++; this.running = false; this.controller?.abort(); this.controller = undefined; }
	begin(): { generation: number; signal: AbortSignal } | undefined { if (this.running) return; this.running = true; this.controller = new AbortController(); return { generation: this.generation, signal: this.controller.signal }; }
	end(token: { generation: number }): void { if (token.generation === this.generation) { this.running = false; this.controller = undefined; } }
	abort(): boolean { if (!this.controller || this.controller.signal.aborted) return false; this.controller.abort(); return true; }
	shutdown(): void { this.abort(); this.generation++; this.running = false; }
	isRunning(): boolean { return this.running; }
}

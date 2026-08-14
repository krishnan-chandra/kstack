import { SessionRunLifecycle, type SessionToken } from "../shared/session-lifecycle.ts";

export interface LandRunToken extends SessionToken {
	readonly signal: AbortSignal;
}

export class LandLifecycle extends SessionRunLifecycle {
	private controller: AbortController | undefined;

	begin(): LandRunToken | undefined {
		const session = this.currentSessionToken();
		if (!session || !this.beginRun(session)) return undefined;
		this.controller = new AbortController();
		return { ...session, signal: this.controller.signal };
	}

	end(token: LandRunToken): void {
		if (!this.isCurrent(token)) return;
		this.controller = undefined;
		this.endRun(token);
	}

	abort(): boolean {
		if (!this.controller || this.controller.signal.aborted) return false;
		this.controller.abort();
		return true;
	}

	protected override onStart(): void {
		this.abort();
		this.controller = undefined;
		super.onStart();
	}

	protected override onShutdown(): void {
		this.abort();
		this.controller = undefined;
		super.onShutdown();
	}
}

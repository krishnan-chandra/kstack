import { SessionRunLifecycle, type SessionToken } from "../shared/session-lifecycle.ts";

interface LandRunToken extends SessionToken {
	readonly signal: AbortSignal;
}

export class StackLandingLifecycle {
	private active: AbortController | undefined;

	begin(): AbortSignal | undefined {
		if (this.active) return undefined;
		this.active = new AbortController();
		return this.active.signal;
	}

	end(signal: AbortSignal): void {
		if (this.active?.signal === signal) this.active = undefined;
	}

	abort(): boolean {
		if (!this.active) return false;
		this.active.abort();
		return true;
	}
}

export class LandLifecycle extends SessionRunLifecycle {
	begin(): LandRunToken | undefined {
		const session = this.currentSessionToken();
		if (!session) return undefined;
		const run = this.beginRun(session);
		if (!run) return undefined;
		const signal = this.runSignal(run);
		if (!signal) {
			this.endRun(run);
			return undefined;
		}
		return { ...run, signal };
	}

	end(token: LandRunToken): void {
		this.endRun(token);
	}

	abort(): boolean {
		return this.abortRun();
	}
}

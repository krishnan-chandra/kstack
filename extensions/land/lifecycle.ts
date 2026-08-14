import { SessionRunLifecycle, type SessionToken } from "../shared/session-lifecycle.ts";

export interface LandRunToken extends SessionToken {
	readonly signal: AbortSignal;
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

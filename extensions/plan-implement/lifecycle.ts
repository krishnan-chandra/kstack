/** Session-aware, phase-aware state for one plan/implement workflow. */

import { SessionRunLifecycle, type SessionToken } from "../shared/session-lifecycle.ts";

export type WorkflowPhase = "idle" | "planning" | "approval" | "implementing" | "fixing" | "publishing";
export type WorkflowToken = SessionToken;

export class WorkflowLifecycle extends SessionRunLifecycle {
	private phase: WorkflowPhase = "idle";
	private childAbort: AbortController | undefined;

	beginWorkflow(expectedSession?: WorkflowToken): WorkflowToken | undefined {
		const session = expectedSession ?? this.currentSessionToken();
		if (!session) return undefined;
		const token = this.beginRun(session);
		if (token) this.phase = "approval";
		return token;
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
		if (!this.isSessionCurrent(token)) return;
		this.childAbort?.abort();
		this.childAbort = undefined;
		this.endRun(token);
		this.phase = "idle";
	}

	currentPhase(): WorkflowPhase {
		return this.phase;
	}

	protected override onStart(): void {
		super.onStart();
		this.phase = "idle";
		this.childAbort = undefined;
	}

	protected override onShutdown(): void {
		super.onShutdown();
		this.childAbort?.abort();
		this.childAbort = undefined;
		this.phase = "idle";
	}
}

/** Session-aware, phase-aware state for one plan/implement workflow. */

import { SessionRunLifecycle, type SessionToken } from "../shared/session-lifecycle.ts";

export type WorkflowPhase = "idle" | "planning" | "approval" | "implementing" | "fixing" | "publishing";
type WorkflowToken = SessionToken;

export class WorkflowLifecycle extends SessionRunLifecycle {
	private phase: WorkflowPhase = "idle";
	private roleAbort: AbortController | undefined;

	beginWorkflow(expectedSession?: WorkflowToken): WorkflowToken | undefined {
		const session = expectedSession ?? this.currentSessionToken();
		if (!session) return undefined;
		const token = this.beginRun(session);
		if (token) this.phase = "approval";
		return token;
	}

	beginRole(
		token: WorkflowToken,
		phase: "planning" | "implementing" | "fixing" | "publishing",
	): AbortController | undefined {
		if (!this.isCurrent(token) || this.roleAbort) return undefined;
		const controller = new AbortController();
		this.roleAbort = controller;
		this.phase = phase;
		return controller;
	}

	endRole(token: WorkflowToken, controller: AbortController): void {
		if (!this.isCurrent(token) || this.roleAbort !== controller) return;
		this.roleAbort = undefined;
		this.phase = "approval";
	}

	abortActiveRole(): boolean {
		if (!this.roleAbort || this.roleAbort.signal.aborted) return false;
		this.roleAbort.abort();
		return true;
	}

	finishWorkflow(token: WorkflowToken): void {
		if (!this.isSessionCurrent(token)) return;
		this.roleAbort?.abort();
		this.roleAbort = undefined;
		this.endRun(token);
		this.phase = "idle";
	}

	currentPhase(): WorkflowPhase {
		return this.phase;
	}

	protected override onStart(): void {
		super.onStart();
		this.phase = "idle";
		this.roleAbort = undefined;
	}

	protected override onShutdown(): void {
		super.onShutdown();
		this.roleAbort?.abort();
		this.roleAbort = undefined;
		this.phase = "idle";
	}
}

/** Session-aware lifecycle for a pr-autopilot run. */

import { SessionRunLifecycle, type SessionToken } from "../shared/session-lifecycle.ts";

export type AutopilotToken = SessionToken;

/** Guards one mutation-capable autopilot run per session. */
export class AutopilotLifecycle extends SessionRunLifecycle {}

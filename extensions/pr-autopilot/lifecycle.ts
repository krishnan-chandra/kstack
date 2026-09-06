/** Session-aware lifecycle for a pr-autopilot run. */

import { SessionRunLifecycle } from "../shared/session-lifecycle.ts";

/** Guards one mutation-capable autopilot run per session. */
export class AutopilotLifecycle extends SessionRunLifecycle {}

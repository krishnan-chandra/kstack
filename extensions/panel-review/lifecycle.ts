/** Session-aware lifecycle for a panel-review run. */

import { SessionRunLifecycle, type SessionToken } from "../shared/session-lifecycle.ts";

export type PanelToken = SessionToken;
export class PanelLifecycle extends SessionRunLifecycle {}

/** In-process confirmation capability for trusted pr-autopilot callers. */

// Pi gives each extension a separate module graph. The global registry keeps the marker stable across those graphs.
const AUTOPILOT_CONFIRMATION = Symbol.for("kstack.pr-autopilot.confirmation");

export interface AutopilotConfirmation {
	readonly [AUTOPILOT_CONFIRMATION]: true;
}

/** Issue a confirmation for a trusted in-process caller that already holds user consent. */
export function issueAutopilotConfirmation(): AutopilotConfirmation {
	return { [AUTOPILOT_CONFIRMATION]: true };
}

export function isAutopilotConfirmation(value: unknown): value is AutopilotConfirmation {
	return (
		typeof value === "object" &&
		value !== null &&
		AUTOPILOT_CONFIRMATION in value &&
		value[AUTOPILOT_CONFIRMATION] === true
	);
}

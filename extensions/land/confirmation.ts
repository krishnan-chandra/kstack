/** In-process confirmation capability for trusted Land callers. */

// Pi gives each extension a separate module graph. The global registry keeps the marker stable across those graphs.
const LAND_CONFIRMATION = Symbol.for("kstack.land.confirmation");

export interface LandConfirmation {
	readonly [LAND_CONFIRMATION]: true;
}

/** Issue a confirmation for a trusted in-process caller. */
export function issueLandConfirmation(): LandConfirmation {
	return { [LAND_CONFIRMATION]: true };
}

export function isLandConfirmation(value: unknown): value is LandConfirmation {
	return typeof value === "object" && value !== null && LAND_CONFIRMATION in value && value[LAND_CONFIRMATION] === true;
}

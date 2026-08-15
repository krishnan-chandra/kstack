/** In-process confirmation capability for trusted Land callers. */

const LAND_CONFIRMATION = Symbol("kstack.land.confirmation");

export interface LandConfirmation {
	readonly [LAND_CONFIRMATION]: true;
}

/** Issue a confirmation that only this module can mint. */
export function issueLandConfirmation(): LandConfirmation {
	return { [LAND_CONFIRMATION]: true };
}

export function isLandConfirmation(value: unknown): value is LandConfirmation {
	return typeof value === "object" && value !== null && LAND_CONFIRMATION in value && value[LAND_CONFIRMATION] === true;
}

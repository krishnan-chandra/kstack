/** A model reference as configured in kstack.json sections. */
export interface ModelSpecLike {
	label?: string;
	model: string;
	thinking?: string;
}

/** Format a spec as a Pi CLI id (provider/model[:thinking]). */
export function modelCliId(spec: ModelSpecLike): string {
	return spec.thinking ? `${spec.model}:${spec.thinking}` : spec.model;
}

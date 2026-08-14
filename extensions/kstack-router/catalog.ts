/** Canonical route catalog. The TypeScript source is authoritative. */

import { ALL_ROUTES, type RouteId, type RouteMetadata } from "./types.ts";

const CATALOG: Record<RouteId, RouteMetadata> = {
	investigate: {
		id: "investigate",
		label: "Investigate",
		description: "Explain, diagnose, research, or understand without requesting a fix. Read-only tools only.",
		playbookFile: "investigate.md",
	},
	change: {
		id: "change",
		label: "Change",
		description:
			"Features, fixes, refactors, prototypes, docs/config changes, and Pi extension implementation. Runs plan → approve → implement → panel review.",
		requires: ["plan-implement", "panel-review"],
	},
	"fast-change": {
		id: "fast-change",
		label: "Fast change",
		description: "Implement an explicit, bounded, low-risk change with one confirmed child and local commits. Skips independent planning and review.",
		requires: ["fast-implement"],
	}, 
	arena: {
		id: "arena",
		label: "Arena",
		description:
			"Spawn N parallel candidates at the same task, cross-judge, graft the winner. First turn is read-only framing.",
		requires: ["skill:arena"],
		playbookFile: "arena.md",
	},
	swarm: {
		id: "swarm",
		label: "Swarm",
		description:
			"Fan out parallel workers across independent slices, aggregate results. First turn is read-only framing.",
		requires: ["skill:swarm"],
		playbookFile: "swarm.md",
	},
	"skill-authoring": {
		id: "skill-authoring",
		label: "Skill Authoring",
		description: "Create, improve, debug, trigger-test, or evaluate a skill. First turn is read-only framing.",
		requires: ["skill:create-skill"],
		playbookFile: "skill-authoring.md",
	},
	"session-pickup": {
		id: "session-pickup",
		label: "Session Pickup",
		description: "Continue linked or archived work and recover prior decisions. Read-only tools only.",
		playbookFile: "session-pickup.md",
	},
	review: {
		id: "review",
		label: "Review",
		description: "Review existing working-tree or branch changes. Runs read-only panel review.",
		requires: ["panel-review"],
	},
	unsupported: {
		id: "unsupported",
		label: "Unsupported",
		description: "Requests that don't fit a bounded safe route. No dispatch is performed.",
	},
};

/**
 * Check that every route has a unique ID and consistent metadata.
 * Returns a list of validation errors (empty = valid).
 */
export function validateCatalog(): string[] {
	const errors: string[] = [];
	const ids = new Set<string>();

	for (const route of ALL_ROUTES) {
		const meta = CATALOG[route];
		if (!meta) {
			errors.push(`Route ${route} missing from catalog.`);
			continue;
		}
		if (ids.has(route)) errors.push(`Duplicate route id: ${route}.`);
		ids.add(route);
		if (meta.id !== route) errors.push(`Route ${route}: metadata id mismatch (${meta.id}).`);
		if (!meta.label) errors.push(`Route ${route}: missing label.`);
		if (!meta.description) errors.push(`Route ${route}: missing description.`);
	}

	// Check that all catalog entries correspond to known routes.
	for (const id of Object.keys(CATALOG)) {
		if (!ids.has(id)) errors.push(`Catalog has unknown route id: ${id}.`);
	}

	return errors;
}

export function getRouteMetadata(id: RouteId): RouteMetadata | undefined {
	return CATALOG[id];
}

export function getRouteLabel(id: RouteId): string {
	return CATALOG[id]?.label ?? id;
}

export function getRouteDescription(id: RouteId): string {
	return CATALOG[id]?.description ?? "";
}

export function getRoutePlaybook(id: RouteId): string | undefined {
	return CATALOG[id]?.playbookFile;
}

export function getAllRoutes(): RouteMetadata[] {
	return ALL_ROUTES.map((id) => CATALOG[id]).filter(Boolean);
}

/**
 * Check that a route is dispatchable given currently loaded command names
 * and skill names. Returns a list of missing dependencies (empty = ready).
 * Skill dependencies are expected as "skill:<skill-name>" in requires[].
 */
export function checkDependencies(
	routeId: RouteId,
	availableCommands: string[],
	availableSkillNames: string[],
): string[] {
	const meta = CATALOG[routeId];
	if (!meta || !meta.requires) return [];

	const missing: string[] = [];
	for (const dep of meta.requires) {
		if (dep.startsWith("skill:")) {
			const skillName = dep.slice(6);
			if (!availableSkillNames.includes(skillName)) {
				missing.push(`skill "${skillName}"`);
			}
		} else {
			if (!availableCommands.includes(dep)) {
				missing.push(`extension command "${dep}"`);
			}
		}
	}
	return missing;
}

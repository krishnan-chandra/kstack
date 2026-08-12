/** Change-kind taxonomy and auditable playbook asset lookup. */

export const CHANGE_KINDS = [
	"bug-fix",
	"feature",
	"refactor",
	"performance",
	"prototype",
	"generic",
] as const;

export type ChangeKind = (typeof CHANGE_KINDS)[number];

const CHANGE_KIND_SET: ReadonlySet<string> = new Set(CHANGE_KINDS);

export function isChangeKind(value: string): value is ChangeKind {
	return CHANGE_KIND_SET.has(value);
}

export function changeKindLabel(kind: ChangeKind): string {
	return {
		"bug-fix": "Bug fix",
		feature: "Feature",
		refactor: "Refactor",
		performance: "Performance",
		prototype: "Prototype",
		generic: "Generic change",
	}[kind];
}

/** Generic changes deliberately receive no specialized proof-obligation asset. */
export function changeKindPlaybookFile(kind: ChangeKind): string | undefined {
	return kind === "generic" ? undefined : `${kind}.md`;
}

export interface SessionChoiceSource {
	path: string;
	id: string;
	name?: string;
	modified: Date;
}

export interface NamedSessionChoice<T extends SessionChoiceSource> {
	label: string;
	session: T;
}

/** Build compact archive choices without falling back to first-message text. */
export function buildNamedSessionChoices<T extends SessionChoiceSource>(sessions: T[]): {
	choices: Array<NamedSessionChoice<T>>;
	unnamedCount: number;
} {
	const named = sessions.flatMap((session) => {
		const name = session.name?.trim();
		return name ? [{ session, name }] : [];
	});
	const counts = new Map<string, number>();
	for (const { name } of named) counts.set(name, (counts.get(name) ?? 0) + 1);

	const labels = new Set<string>();
	const choices = named.map(({ session, name }) => {
		let label = counts.get(name) === 1 ? name : `${name} — ${session.modified.toISOString()}`;
		if (labels.has(label)) label = `${label} — ${session.id.slice(0, 8)}`;
		labels.add(label);
		return { label, session };
	});
	return { choices, unnamedCount: sessions.length - named.length };
}

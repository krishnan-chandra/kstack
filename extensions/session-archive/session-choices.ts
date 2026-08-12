export interface SessionChoiceSource {
	path: string;
	id: string;
	name?: string;
	firstMessage?: string;
	modified: Date;
}

export interface SessionChoice<T extends SessionChoiceSource> {
	label: string;
	session: T;
}

/** Build compact archive choices for named and unnamed inactive sessions. */
export function buildSessionChoices<T extends SessionChoiceSource>(sessions: T[]): Array<SessionChoice<T>> {
	const candidates = sessions.map((session) => {
		const name = session.name?.trim();
		const firstMessage = session.firstMessage?.replace(/\s+/g, " ").trim();
		const summary = firstMessage ? firstMessage.slice(0, 60) : undefined;
		return {
			session,
			baseLabel: name || `(unnamed)${summary ? ` — ${summary}` : ""}`,
		};
	});
	const counts = new Map<string, number>();
	for (const { baseLabel } of candidates) counts.set(baseLabel, (counts.get(baseLabel) ?? 0) + 1);

	const labels = new Set<string>();
	return candidates.map(({ session, baseLabel }) => {
		let label = counts.get(baseLabel) === 1 ? baseLabel : `${baseLabel} — ${session.modified.toISOString()}`;
		if (labels.has(label)) label = `${label} — ${session.id.slice(0, 8)}`;
		labels.add(label);
		return { label, session };
	});
}

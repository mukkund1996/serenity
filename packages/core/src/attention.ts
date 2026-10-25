import type { Session, Suggestion } from "./domain";

/** Category for sessions the master has not placed yet. */
export const UNSORTED = "unsorted";

export interface CategoryGroup {
	name: string;
	sessions: Session[];
	attention: number;
	counts: { waiting: number; working: number; done: number };
}

function needRank(s: Session, suggested: Set<string>): number {
	if (s.watched && s.status === "done") return 0;
	if (s.status === "waiting") return 1;
	if (s.status === "dead") return 2;
	if (suggested.has(s.id)) return 3;
	return -1;
}

/**
 * The master's NEEDS YOU list: watched-and-finished, then waiting, then dead,
 * then anything else with a pending suggestion.
 */
export function needsYou(
	sessions: Session[],
	suggestions: Suggestion[] = [],
): Session[] {
	const suggested = new Set(suggestions.map((g) => g.sessionId));
	return sessions
		.filter((s) => needRank(s, suggested) >= 0)
		.sort(
			(a, b) =>
				needRank(a, suggested) - needRank(b, suggested) ||
				a.updatedAt - b.updatedAt,
		);
}

function attentionOf(sessions: Session[]): number {
	let score = 0;
	for (const s of sessions) {
		if (s.status === "waiting") score += 100;
		else if (s.status === "dead") score += 10;
		else if (s.status === "done" && s.watched) score += 1;
	}
	return score;
}

/** Groups sessions by category, most attention first, then by name. */
export function groupCategories(sessions: Session[]): CategoryGroup[] {
	const byName = new Map<string, Session[]>();
	for (const s of sessions) {
		const name = s.category ?? UNSORTED;
		const list = byName.get(name) ?? [];
		list.push(s);
		byName.set(name, list);
	}
	return [...byName]
		.map(([name, list]) => ({
			name,
			sessions: list,
			attention: attentionOf(list),
			counts: {
				waiting: list.filter((s) => s.status === "waiting").length,
				working: list.filter((s) => s.status === "working").length,
				done: list.filter((s) => s.status === "done").length,
			},
		}))
		.sort((a, b) => b.attention - a.attention || a.name.localeCompare(b.name));
}

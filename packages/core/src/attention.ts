import type { Session, Suggestion } from "./domain";

/** Topic for sessions the master has not placed yet. */
export const UNSORTED = "unsorted";

/** Topic of pinned sessions (ADR 0022); the master never assigns it. */
export const PINNED = "pinned";

/** The topic a session is drawn under: pinned, its own, or unsorted. */
export function topicOf(s: Session): string {
	return s.pinned ? PINNED : (s.topic ?? UNSORTED);
}

export interface TopicGroup {
	name: string;
	sessions: Session[];
	attention: number;
	counts: { waiting: number; working: number; done: number };
}

function needRank(s: Session, suggested: Set<string>): number {
	if (s.watched && s.status === "done") return 0;
	if (s.status === "waiting") return 1;
	// A pinned session that ended waits to be resumed; it needs nothing.
	if (s.status === "dead" && !s.pinned) return 2;
	if (suggested.has(s.id)) return 3;
	return -1;
}

/**
 * A reply the master's chat wants to send to a session (`suggest` kind
 * reply, or a `send_reply` the user had not confirmed): it waits in the
 * master's queue, not NEEDS YOU (ADR 0039).
 */
export function isQueued(g: Suggestion): boolean {
	return g.status === "pending" && g.kind === "reply" && g.source === "chat";
}

/** The master's queue: its queued replies to sessions on the map, oldest first. */
export function masterQueue(
	sessions: Session[],
	suggestions: Suggestion[],
): Array<{ suggestion: Suggestion; session: Session }> {
	const byId = new Map(sessions.map((s) => [s.id, s]));
	return suggestions
		.filter(isQueued)
		.flatMap((suggestion) => {
			const session = byId.get(suggestion.sessionId);
			return session ? [{ suggestion, session }] : [];
		})
		.sort((a, b) => a.suggestion.createdAt - b.suggestion.createdAt);
}

/**
 * The master's NEEDS YOU list: watched-and-finished, then waiting, then dead,
 * then anything else with a pending suggestion. Queued replies don't count;
 * they have their own section.
 */
export function needsYou(
	sessions: Session[],
	suggestions: Suggestion[] = [],
): Session[] {
	const suggested = new Set(
		suggestions.filter((g) => !isQueued(g)).map((g) => g.sessionId),
	);
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
		else if (s.status === "dead" && !s.pinned) score += 10;
		else if (s.status === "done" && s.watched) score += 1;
	}
	return score;
}

function byTopic(sessions: Session[]): Map<string, Session[]> {
	const byName = new Map<string, Session[]>();
	for (const s of sessions) {
		const name = topicOf(s);
		const list = byName.get(name) ?? [];
		list.push(s);
		byName.set(name, list);
	}
	return byName;
}

/** Card order inside a topic: waiting on you, in progress, finished, then the rest. */
const CARD_RANK: Record<Session["status"], number> = {
	waiting: 0,
	working: 1,
	done: 2,
	idle: 3,
	dead: 4,
	archived: 5,
};

/**
 * The map's topics: pinned first, then most attention first, then by
 * name, each with its cards in CARD_RANK order. Archived sessions are left
 * out, so a topic holding only archived ones is gone.
 */
export function groupTopics(sessions: Session[]): TopicGroup[] {
	const byName = byTopic(sessions.filter((s) => s.status !== "archived"));
	return [...byName]
		.map(([name, list]) => ({
			name,
			sessions: list.sort((a, b) => CARD_RANK[a.status] - CARD_RANK[b.status]),
			attention: attentionOf(list),
			counts: {
				waiting: list.filter((s) => s.status === "waiting").length,
				working: list.filter((s) => s.status === "working").length,
				done: list.filter((s) => s.status === "done").length,
			},
		}))
		.sort(
			(a, b) =>
				Number(b.name === PINNED) - Number(a.name === PINNED) ||
				b.attention - a.attention ||
				a.name.localeCompare(b.name),
		);
}

/** The archived list (H): archived sessions under their topic, newest first. */
export function archivedTopics(
	sessions: Session[],
): Array<{ name: string; sessions: Session[] }> {
	const byName = byTopic(sessions.filter((s) => s.status === "archived"));
	return [...byName]
		.map(([name, list]) => ({
			name,
			sessions: list.sort((a, b) => b.updatedAt - a.updatedAt),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

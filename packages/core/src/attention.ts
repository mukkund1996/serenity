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
 * master's queue, not NEEDS YOU (ADR 0040).
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
 * Whether the user dismissed a session from NEEDS YOU with Enter (ADR 0050)
 * and nothing new has come since: a waiting session always shows, and so
 * does one with a suggestion newer than the dismissal.
 */
function dismissed(s: Session, suggestions: Suggestion[]): boolean {
	const at = s.dismissedAt;
	if (at === null || s.status === "waiting") return false;
	return !suggestions.some((g) => g.sessionId === s.id && g.createdAt > at);
}

/**
 * The master's NEEDS YOU list: watched-and-finished, then waiting, then dead,
 * then anything else with a pending suggestion. Queued replies don't count;
 * they have their own section. Dismissed sessions are left out.
 */
export function needsYou(
	sessions: Session[],
	suggestions: Suggestion[] = [],
): Session[] {
	const open = suggestions.filter((g) => !isQueued(g));
	const suggested = new Set(open.map((g) => g.sessionId));
	return sessions
		.filter((s) => needRank(s, suggested) >= 0 && !dismissed(s, open))
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

/**
 * What y on a session's suggestion does, as a verb and its target, and the
 * text or detail that goes with it (ADR 0050): "Tell api-auth" and the reply,
 * "Approve in api-auth" and the prompt.
 */
export function suggestionAction(
	g: Pick<Suggestion, "kind" | "label" | "text">,
	session: Pick<Session, "name">,
): { action: string; text: string | null } {
	const rest = (prefix: RegExp) => g.label.replace(prefix, "").trim() || null;
	switch (g.kind) {
		case "reply":
			return { action: `Tell ${session.name}`, text: g.text };
		case "approve":
			return {
				action: `Approve in ${session.name}`,
				text: rest(/^approve\b:?/i),
			};
		case "cleanup":
			return {
				action: `Clean up ${session.name}`,
				text: rest(/^clean(\s|-)?up\b:?/i),
			};
		case "review":
			return {
				action: `Request review on ${session.name}`,
				text: g.text ? `@${g.text.replace(/^@/, "")}` : null,
			};
	}
}

/** The action line as one string, e.g. "Tell api-auth: yes, set it to 15m". */
export function actionLine(a: { action: string; text: string | null }): string {
	return a.text ? `${a.action}: ${a.text}` : a.action;
}

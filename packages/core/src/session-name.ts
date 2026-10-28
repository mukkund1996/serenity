import type { Session } from "./domain";

/** Live beats ended beats archived when a name is shared. */
function rank(session: Session): number {
	if (session.status === "archived") return 0;
	return session.status === "dead" ? 1 : 2;
}

/**
 * The session a name means. Names are unique only among live sessions: an
 * archived session keeps its name, so a new one may reuse it. Prefers a live
 * session, then an ended one, then an archived one; among equals, the most
 * recently created.
 */
export function findSessionByName(
	sessions: readonly Session[],
	name: unknown,
): Session | undefined {
	let best: Session | undefined;
	for (const s of sessions) {
		if (s.name !== name) continue;
		if (
			!best ||
			rank(s) > rank(best) ||
			(rank(s) === rank(best) && s.createdAt > best.createdAt)
		)
			best = s;
	}
	return best;
}

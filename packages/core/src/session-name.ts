import type { Session } from "./domain";
// Used only when called, so the import cycle with mentions is harmless.
import { isReservedName } from "./mentions";

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

/** What a session name may be: letters, digits, . _ - and at most 40 long. */
export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/i;

/** Said when a name breaks NAME_PATTERN. */
export const NAME_RULE = "name: letters, digits, . _ - (max 40)";

/**
 * Whether `session` keeps its name from others: it is not archived, and not
 * ended unless pinned (attaching resumes a pinned one under its name).
 */
function holdsName(session: Session): boolean {
	if (session.status === "archived") return false;
	return session.status !== "dead" || session.pinned;
}

/**
 * Checks a name for a new or renamed session (ADR 0063): spaces become `-`,
 * it must match NAME_PATTERN, it must not be a command word (`@new`, `@move`,
 * any case; ADR 0048), and no other session that holds its name may have it,
 * in any case. `self` is the session being renamed. Returns the name to use,
 * or why it can't be used.
 */
export function checkSessionName(
	raw: string,
	sessions: readonly Session[],
	self?: string,
): { name: string } | { error: string } {
	const name = raw.trim().replace(/\s+/g, "-");
	if (!name) return { error: "Give the session a name." };
	if (!NAME_PATTERN.test(name)) return { error: NAME_RULE };
	if (isReservedName(name))
		return {
			error: `${name} is reserved for @${name.toLowerCase()} in the master; pick another name`,
		};
	const lower = name.toLowerCase();
	const clash = sessions.find(
		(s) => s.id !== self && s.name.toLowerCase() === lower && holdsName(s),
	);
	if (clash) return { error: `a session named ${clash.name} already exists` };
	return { name };
}

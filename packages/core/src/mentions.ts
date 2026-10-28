import type { MasterMessage, Session } from "./domain";
import { findSessionByName } from "./session-name";

/**
 * `@session` in a message to the master (ADR 0036): the message is about that
 * session, and the master acts on it directly. The TUI completes names as the
 * user types; the daemon reads them back from the stored message.
 */

/** A mention not glued to a word or another `@`, so `me@host` is no mention. */
const MENTION = /(?<![\w@])@([a-z0-9][a-z0-9._-]*)/gi;
/** The mention being typed at the end of the text; its name may be empty. */
const DRAFT = /(?<![\w@])@([a-z0-9._-]*)$/i;

/** Matches shown at once in the autocomplete list. */
export const MENTION_LIST_MAX = 4;

/**
 * The live sessions a message @-mentions by exact name, once each, in the
 * order mentioned. A name shared with an archived session means the live one
 * (findSessionByName); one that only an archived session has mentions nothing.
 * Punctuation after a name ("@api-auth, then") is not part of it, unless a
 * session is named with it.
 */
export function mentionedSessions(
	text: string,
	sessions: readonly Session[],
): Session[] {
	const found = new Map<string, Session>();
	for (const [, token] of text.matchAll(MENTION)) {
		let name = token as string;
		for (;;) {
			const session = findSessionByName(sessions, name);
			if (session && session.status !== "archived") {
				found.set(session.id, session);
				break;
			}
			const shorter = name.replace(/[._-]+$/, "");
			if (shorter === name || !shorter) break;
			name = shorter;
		}
	}
	return [...found.values()];
}

/**
 * Whether the user's latest chat message @-mentions this session: the proof
 * send_reply needs to go out at once (ADR 0036). `conversation` is the repo's
 * newest messages, oldest first; serenity's own messages are never the user's.
 */
export function mentionsSession(
	conversation: readonly MasterMessage[],
	sessions: readonly Session[],
	session: Session,
): boolean {
	const last = conversation.at(-1);
	if (last?.from !== "you") return false;
	return mentionedSessions(last.text, sessions).some(
		(s) => s.id === session.id,
	);
}

/** The `@name` being typed at the end of `text`, or null when there is none. */
export function mentionDraft(
	text: string,
): { query: string; start: number } | null {
	const hit = DRAFT.exec(text);
	if (!hit) return null;
	return { query: hit[1] as string, start: hit.index };
}

/**
 * Names the autocomplete offers for `query`: live (not archived) sessions,
 * names starting with it first, then names containing it, each group in the
 * order given. Case does not matter; a name shows once.
 */
export function matchMentions(
	sessions: readonly Session[],
	query: string,
): string[] {
	const q = query.toLowerCase();
	const names = [
		...new Set(
			sessions.filter((s) => s.status !== "archived").map((s) => s.name),
		),
	];
	const lower = (name: string) => name.toLowerCase();
	return [
		...names.filter((n) => lower(n).startsWith(q)),
		...names.filter((n) => !lower(n).startsWith(q) && lower(n).includes(q)),
	];
}

/** `text` with the `@query` being typed replaced by `@name `. */
export function completeMention(text: string, name: string): string {
	const draft = mentionDraft(text);
	return `${draft ? text.slice(0, draft.start) : text}@${name} `;
}

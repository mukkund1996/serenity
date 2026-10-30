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
 * `@word`s that tell the master to do something rather than name a session
 * (ADR 0048). They are never session names, in any case.
 */
export const MASTER_COMMANDS = {
	new: "start sessions from a brief",
	copy: "hand a session's work to a new session",
	handover: "get a session's handover doc",
} as const;

export type MasterCommand = keyof typeof MASTER_COMMANDS;

/** Whether `name` is a command word, so no session may take it. */
export function isReservedName(name: string): boolean {
	return Object.hasOwn(MASTER_COMMANDS, name.toLowerCase());
}

/** What the autocomplete shows beside a command word; null for a session name. */
export function commandHint(name: string): string | null {
	return Object.hasOwn(MASTER_COMMANDS, name)
		? MASTER_COMMANDS[name as MasterCommand]
		: null;
}

/**
 * The commands a message uses, once each, in the order used. Exact and
 * lowercase, like names: `@New` is no command. Punctuation after one
 * (`@new:`) is not part of it.
 */
export function masterCommands(text: string): MasterCommand[] {
	const found = new Set<MasterCommand>();
	for (const [, token] of text.matchAll(MENTION)) {
		const word = (token as string).replace(/[._-]+$/, "");
		if (Object.hasOwn(MASTER_COMMANDS, word)) found.add(word as MasterCommand);
	}
	return [...found];
}

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
			if (isReservedName(name)) break;
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
 * Names the autocomplete offers for `query`: the commands starting with it,
 * then live (not archived) sessions, names starting with it first, then
 * names containing it, each group in the order given. Case does not matter;
 * a name shows once, and a session named like a command never shows.
 */
export function matchMentions(
	sessions: readonly Session[],
	query: string,
): string[] {
	const q = query.toLowerCase();
	const names = [
		...new Set(
			sessions
				.filter((s) => s.status !== "archived" && !isReservedName(s.name))
				.map((s) => s.name),
		),
	];
	const lower = (name: string) => name.toLowerCase();
	return [
		...Object.keys(MASTER_COMMANDS).filter((c) => c.startsWith(q)),
		...names.filter((n) => lower(n).startsWith(q)),
		...names.filter((n) => !lower(n).startsWith(q) && lower(n).includes(q)),
	];
}

/** `text` with the `@query` being typed replaced by `@name `. */
export function completeMention(text: string, name: string): string {
	const draft = mentionDraft(text);
	return `${draft ? text.slice(0, draft.start) : text}@${name} `;
}

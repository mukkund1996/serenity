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
 * The live session a mention's token names, and how much of the token the
 * name takes: the whole token, or less when punctuation trails it.
 */
function resolveSession(
	token: string,
	sessions: readonly Session[],
): { session: Session; name: string } | null {
	let name = token;
	for (;;) {
		if (isReservedName(name)) return null;
		const session = findSessionByName(sessions, name);
		if (session && session.status !== "archived") return { session, name };
		const shorter = name.replace(/[._-]+$/, "");
		if (shorter === name || !shorter) return null;
		name = shorter;
	}
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
		const hit = resolveSession(token as string, sessions);
		if (hit) found.set(hit.session.id, hit.session);
	}
	return [...found.values()];
}

/** What an `@word` turns out to be: a live session's name, or a command word. */
export type MentionKind = "session" | MasterCommand;

/** A piece of a message: an `@word` that resolves, or plain text (`kind` null). */
export interface MentionSegment {
	text: string;
	kind: MentionKind | null;
}

/**
 * `text` cut into plain text and the `@word`s that resolve, so the TUI can
 * colour them (ADR 0052). A command word resolves as masterCommands reads
 * it, a session name as mentionedSessions does; punctuation after either
 * stays plain, and so does an `@word` that names nothing. Joined back,
 * the segments are `text`.
 */
export function mentionSegments(
	text: string,
	sessions: readonly Session[],
): MentionSegment[] {
	const segments: MentionSegment[] = [];
	let plainFrom = 0;
	for (const match of text.matchAll(MENTION)) {
		const token = match[1] as string;
		const word = token.replace(/[._-]+$/, "");
		let kind: MentionKind | null = null;
		let name = word;
		if (Object.hasOwn(MASTER_COMMANDS, word)) kind = word as MasterCommand;
		else {
			const hit = resolveSession(token, sessions);
			if (hit) {
				kind = "session";
				name = hit.name;
			}
		}
		if (kind === null) continue;
		if (match.index > plainFrom)
			segments.push({ text: text.slice(plainFrom, match.index), kind: null });
		segments.push({ text: `@${name}`, kind });
		plainFrom = match.index + 1 + name.length;
	}
	if (plainFrom < text.length)
		segments.push({ text: text.slice(plainFrom), kind: null });
	return segments;
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

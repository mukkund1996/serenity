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
	move: "move sessions to a topic",
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

/** What `@move @a @b <topic>` asks for (ADR 0063). */
export interface MoveRequest {
	/** The live sessions to move, once each, in the order mentioned. */
	sessions: Session[];
	/** `@word`s that name no live session (and are no command), as typed. */
	unknown: string[];
	/** The topic, as typed and trimmed; null when the message names none. */
	topic: string | null;
}

/** Words that may lead the topic: "to release", "into the release topic". */
const MOVE_LEAD = /^(?:(?:to|into|under|in|the|topic)\s+)+/i;
/** Words that may trail it: "release topic". */
const MOVE_TRAIL = /\s+topic$/i;

/**
 * Reads `@move` from a message: every live session it @-mentions, and the
 * topic: the first text after `@move` that is more than what joins the
 * mentions ("@a, @b and @c"), up to its first clause break (, ; ! ? a
 * sentence's full stop, or a new line). "to", "into", "under", "the" and a
 * trailing "topic" are not part of it, and nor are quotes around it. Null
 * when the message has no `@move`.
 */
export function parseMove(
	text: string,
	sessions: readonly Session[],
): MoveRequest | null {
	if (!masterCommands(text).includes("move")) return null;
	const found = new Map<string, Session>();
	const unknown: string[] = [];
	// The text between and after the @words from @move on, less what only
	// joins them ("@a, @b and @c").
	const pieces: string[] = [];
	let plainFrom = 0;
	let afterMove = false;
	for (const match of text.matchAll(MENTION)) {
		const token = match[1] as string;
		const word = token.replace(/[._-]+$/, "");
		let name = word;
		if (!Object.hasOwn(MASTER_COMMANDS, word)) {
			const hit = resolveSession(token, sessions);
			if (hit) {
				found.set(hit.session.id, hit.session);
				name = hit.name;
			} else if (!unknown.includes(word)) unknown.push(word);
		}
		if (afterMove) pieces.push(text.slice(plainFrom, match.index));
		afterMove ||= word === "move";
		plainFrom = match.index + 1 + name.length;
	}
	pieces.push(text.slice(plainFrom));
	const clause = (
		pieces.find((piece) => !/^[\s,:&+]*(?:and)?[\s,&+]*$/i.test(piece)) ?? ""
	)
		.replace(/^[ \t,:;.-]+/, "")
		.split(/[,;!?\n]|\.(?:\s|$)/)[0] as string;
	const topic = clause
		.trim()
		.replace(/^["'`]+|["'`]+$/g, "")
		.replace(MOVE_LEAD, "")
		.replace(MOVE_TRAIL, "")
		.replace(/^["'`]+|["'`]+$/g, "")
		.trim();
	return { sessions: [...found.values()], unknown, topic: topic || null };
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
	const names = liveNames(sessions);
	return [
		...Object.keys(MASTER_COMMANDS).filter((c) => c.startsWith(q)),
		...matchNames(names, q),
	];
}

/** Live sessions' names, once each, in the order given; none named like a command. */
function liveNames(sessions: readonly Session[]): string[] {
	return [
		...new Set(
			sessions
				.filter((s) => s.status !== "archived" && !isReservedName(s.name))
				.map((s) => s.name),
		),
	];
}

/** `names` starting with `query`, then those containing it; case does not matter. */
function matchNames(names: readonly string[], query: string): string[] {
	const q = query.toLowerCase();
	const lower = (name: string) => name.toLowerCase();
	return [
		...names.filter((n) => lower(n).startsWith(q)),
		...names.filter((n) => !lower(n).startsWith(q) && lower(n).includes(q)),
	];
}

/**
 * What the master input completes at its cursor (ADR 0067), from the text
 * before the cursor. Each command leads on to what it needs next, so the
 * user never has to remember it:
 * - `mention`: an `@query` being typed; the list offers commands, then live
 *   sessions (ADR 0036).
 * - `session`: right after `@copy `, `@handover ` or `@move `, before any
 *   session is named; the list offers live sessions, filtered by the bare
 *   word being typed, and picking one writes `@name `.
 * - `brief`: `@copy @a `; no list, the new session's brief comes next.
 * - `to`: `@move @a ` (any more sessions joined by `,` `and` `&`); no list,
 *   another `@` names one more, and space or Tab writes `to `.
 * - `topic`: `@move @a to `; the list offers the map's topics, filtered by
 *   what follows "to", and picking one writes its name.
 * `start` is where the text a pick replaces begins. The last command in the
 * text counts; `@new` takes no session, so it completes nothing.
 */
export type Completion =
	| { kind: "mention" | "session" | "topic"; query: string; start: number }
	| { kind: "brief" | "to"; query: ""; start: number };

/** The sessions after `@move`, and what joins them: " @a, @b and @c". */
const MOVE_NAMES = /^(?:[ \t,&+]+(?:and[ \t]+)?@[a-z0-9][a-z0-9._-]*)+/i;

/** What the master input completes at the end of `before` (see Completion). */
export function completionAt(before: string): Completion | null {
	const draft = mentionDraft(before);
	if (draft) return { kind: "mention", ...draft };
	let command: { word: MasterCommand; end: number } | null = null;
	for (const match of before.matchAll(MENTION)) {
		const token = match[1] as string;
		if (Object.hasOwn(MASTER_COMMANDS, token))
			command = {
				word: token as MasterCommand,
				end: match.index + 1 + token.length,
			};
	}
	if (!command || command.word === "new") return null;
	const end = before.length;
	const rest = before.slice(command.end);
	const bare = /^[ \t]+([a-z0-9._-]*)$/i.exec(rest);
	if (bare) {
		const query = bare[1] as string;
		return { kind: "session", query, start: end - query.length };
	}
	if (command.word === "handover") return null;
	const names = MOVE_NAMES.exec(rest);
	if (!names) return null;
	const tail = rest.slice(names[0].length);
	if (/^[ \t]+$/.test(tail))
		return {
			kind: command.word === "copy" ? "brief" : "to",
			query: "",
			start: end,
		};
	if (command.word !== "move") return null;
	const topic = /^[ \t]+(?:in)?to[ \t]+([^,;!?\n]*)$/i.exec(tail);
	if (!topic) return null;
	const query = topic[1] as string;
	return { kind: "topic", query, start: end - query.length };
}

/**
 * The names the list offers for `completion`: commands and live sessions for
 * a `mention` (matchMentions), live sessions alone for a `session`, and
 * `topics` (the map's, in its order) for a `topic`; those starting with the
 * query first, then those containing it. Nothing for `brief` and `to`.
 */
export function completionOptions(
	completion: Completion,
	sessions: readonly Session[],
	topics: readonly string[],
): string[] {
	switch (completion.kind) {
		case "mention":
			return matchMentions(sessions, completion.query);
		case "session":
			return matchNames(liveNames(sessions), completion.query);
		case "topic":
			return matchNames([...new Set(topics)], completion.query.trim());
		default:
			return [];
	}
}

/**
 * `before` (the text before the cursor) with `name` picked from the list:
 * `@name ` for a session or command, the topic's bare name for a topic.
 */
export function applyCompletion(
	before: string,
	completion: Completion,
	name: string,
): string {
	const head = before.slice(0, completion.start);
	return completion.kind === "topic" ? head + name : `${head}@${name} `;
}

/**
 * Where the topic an `@move` reads (parseMove) sits in `text`, so the input
 * can colour it; null when there is none. The first place after `@move`
 * that is not inside an `@word`.
 */
export function moveTopicSpan(
	text: string,
	sessions: readonly Session[],
): { start: number; end: number } | null {
	const topic = parseMove(text, sessions)?.topic;
	if (!topic) return null;
	const words = [...text.matchAll(MENTION)].map((m) => ({
		start: m.index,
		end: m.index + m[0].length,
	}));
	const from = words.find(
		(w) => text.slice(w.start + 1, w.end).replace(/[._-]+$/, "") === "move",
	)?.end;
	if (from === undefined) return null;
	const lower = text.toLowerCase();
	const want = topic.toLowerCase();
	for (let at = lower.indexOf(want, from); at >= 0; ) {
		const end = at + want.length;
		if (!words.some((w) => at < w.end && end > w.start))
			return { start: at, end };
		at = lower.indexOf(want, at + 1);
	}
	return null;
}

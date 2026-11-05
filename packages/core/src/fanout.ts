import type { FanoutSession, Session, Suggestion } from "./domain";
import { oneLine } from "./status";

/**
 * Fan-out (ADR 0060): an agent session asks serenity, through its
 * `request_sessions` MCP tool, to start new sessions for parts of its work.
 * Pure rules here; the daemon applies them.
 */

/** Sessions one request may ask for. */
export const FANOUT_MAX = 5;
/** Live children a parent may have at once, those being asked for included. */
export const CHILDREN_MAX = 8;
/** A prompt shorter than this cannot be self-contained. */
export const FANOUT_PROMPT_MIN = 40;
/** Hook events searched for the parent's latest prompt. */
export const PROMPT_LOOKBACK = 200;

/**
 * Words in the user's latest prompt that ask for sessions: "split this into
 * 3 sessions", "fan out", "in parallel", "spin up agents".
 */
const ASKS_FOR_SESSIONS =
	/\b(sessions?|fan[\s-]?out|split|parallel|spin\s+up|spawn|agents?|worktrees?)\b/i;

/** Whether the user's latest prompt to the agent asked for new sessions. */
export function userAskedForSessions(prompt: string | null): boolean {
	return !!prompt && ASKS_FOR_SESSIONS.test(prompt);
}

/** A session that still runs or may run again: not archived, not ended. */
export function isLive(s: Session): boolean {
	return s.status !== "archived" && s.status !== "dead";
}

/** Reads request_sessions' `sessions` argument; a string when it is unusable. */
export function parseFanoutSessions(raw: unknown): FanoutSession[] | string {
	if (!Array.isArray(raw) || raw.length === 0)
		return "Give sessions: a list of { name, prompt }.";
	if (raw.length > FANOUT_MAX)
		return `At most ${FANOUT_MAX} sessions per request; you asked for ${raw.length}.`;
	const out: FanoutSession[] = [];
	for (const item of raw) {
		const o = (item ?? {}) as Record<string, unknown>;
		const name = typeof o.name === "string" ? o.name.trim() : "";
		const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
		if (!name) return "Every session needs a name.";
		if (prompt.length < FANOUT_PROMPT_MIN)
			return `${name}'s prompt is too short to stand alone. The new session sees nothing of this conversation: say what to do, where, and what done looks like.`;
		if (out.some((s) => s.name.toLowerCase() === name.toLowerCase()))
			return `${name} is in the list twice.`;
		out.push({ name, prompt });
	}
	return out;
}

/** Why `parent` may not fan out `count` more sessions, or null if it may. */
export function fanoutProblem(
	parent: Session,
	count: number,
	all: Session[],
): string | null {
	if (parent.parentId)
		return "This session was started by another session's fan-out, so it cannot fan out itself. Do the work here, or tell the user it needs more sessions.";
	if (!isLive(parent)) return `${parent.name} has ended.`;
	const live = all.filter((s) => s.parentId === parent.id && isLive(s)).length;
	if (live + count > CHILDREN_MAX)
		return `${parent.name} already has ${live} live sessions; at most ${CHILDREN_MAX} at once. Wait for some to finish, or ask for fewer.`;
	return null;
}

/** The NEEDS YOU line for a fanout, e.g. "Start 3 sessions: api, ui, docs". */
export function fanoutLabel(sessions: FanoutSession[]): string {
	const names = sessions.map((s) => s.name).join(", ");
	return `Start ${sessions.length} session${sessions.length === 1 ? "" : "s"}: ${names}`;
}

/** The fanout's detail under its action line: why, then each first prompt. */
export function fanoutText(sessions: FanoutSession[], reason: string): string {
	const parts = sessions.map(
		(s) => `${s.name}: ${oneLine(s.prompt, 120) ?? ""}`,
	);
	return [oneLine(reason, 160), ...parts].filter(Boolean).join(" · ");
}

/**
 * What a child's change tells its parent, or null: a turn that ended
 * (finished, a question, ended), not a permission prompt, which the user
 * answers in serenity.
 */
export function childReport(before: Session, after: Session): string | null {
	if (before.status === after.status) return null;
	if (after.status === "dead" || after.status === "archived")
		return `${after.name} has ended`;
	if (before.status !== "working" || after.status === "working") return null;
	if (after.status === "waiting" && after.waitingOn === "permission")
		return null;
	const reply = oneLine(after.lastAssistantMessage, 400);
	if (after.status === "waiting")
		return `${after.name} asks: ${oneLine(after.ask, 300) ?? reply ?? "needs an answer"}`;
	return `${after.name} finished its turn${reply ? `: ${reply}` : ""}`;
}

/** The one line sent into a parent's pane with its children's reports. */
export function reportMessage(reports: string[]): string {
	return `[serenity] From the sessions you started: ${reports.join(" | ")}. The user sees them on the map; carry on with your own work, and tell the user only what changes it.`;
}

/**
 * Sessions in drawing order with each child right after its parent, when
 * the parent is in the same list; others keep their place.
 */
export function withChildrenUnderParents(sessions: Session[]): Session[] {
	const ids = new Set(sessions.map((s) => s.id));
	const children = new Map<string, Session[]>();
	for (const s of sessions)
		if (s.parentId && ids.has(s.parentId)) {
			const list = children.get(s.parentId) ?? [];
			list.push(s);
			children.set(s.parentId, list);
		}
	const out: Session[] = [];
	for (const s of sessions) {
		if (s.parentId && ids.has(s.parentId)) continue;
		out.push(s, ...(children.get(s.id) ?? []));
	}
	return out;
}

/** Whether a session is drawn nested under its parent in this list. */
export function nestedIn(s: Session, sessions: Session[]): boolean {
	return !!s.parentId && sessions.some((p) => p.id === s.parentId);
}

/** A session's fanout request if it has one, else its first suggestion. */
export function preferFanout(list: Suggestion[]): Suggestion | undefined {
	return list.find((g) => g.kind === "fanout") ?? list[0];
}

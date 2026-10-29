import type { Session } from "./domain";

/** Restarts allowed within RESPAWN_WINDOW_MS before a session is left ended (ADR 0044). */
export const RESPAWN_LIMIT = 5;
export const RESPAWN_WINDOW_MS = 10 * 60_000;
/** The first restart waits this long; each further one in the window doubles it. */
export const RESPAWN_BASE_MS = 1000;

export type RespawnDecision =
	| { kind: "ignore" }
	| { kind: "respawn"; delayMs: number; note: string }
	| { kind: "end"; reason: string };

const exitCode = (code: number | null) =>
	code === null ? "an unknown code" : `code ${code}`;

/**
 * What to do when a session's claude exits: nothing if serenity archived it,
 * end it if it never started (a refused trust prompt) or keeps exiting,
 * otherwise restart it after a backoff. `recent` counts the restarts already
 * made within the window. Pure, so the policy is tested apart from tmux.
 */
export function respawnDecision(
	session: Session,
	code: number | null,
	recent: number,
	baseMs = RESPAWN_BASE_MS,
): RespawnDecision {
	if (session.status === "archived" || session.status === "dead")
		return { kind: "ignore" };
	if (!session.claudeSessionId)
		return {
			kind: "end",
			reason: `claude exited before it started (${exitCode(code)})`,
		};
	if (recent >= RESPAWN_LIMIT)
		return {
			kind: "end",
			reason: `claude exited ${recent + 1} times in ${RESPAWN_WINDOW_MS / 60_000} min (last with ${exitCode(code)})`,
		};
	return {
		kind: "respawn",
		delayMs: baseMs * 2 ** recent,
		note: `claude exited (${exitCode(code)}); restarted`,
	};
}

/** The arguments that continue a session's conversation when claude is restarted. */
export function resumeArgs(session: Session): string[] {
	return session.claudeSessionId
		? ["--resume", session.claudeSessionId]
		: ["--continue"];
}

import type { HookKind, HookPayload, Session } from "./domain";

/** Notification types that mean the agent is blocked on the user. */
const WAITING_NOTIFICATIONS = new Set([
	"permission_prompt",
	"elicitation_dialog",
	"elicitation_url_dialog",
	"agent_needs_input",
]);

export const ONE_LINE_MAX = 200;

/** Enough of the agent's reply for the summarizer; cards cut it further. */
export const REPLY_MAX = 2000;

export function oneLine(
	text: string | null | undefined,
	max = ONE_LINE_MAX,
): string | null {
	if (!text) return null;
	const line = text.replace(/\s+/g, " ").trim();
	if (!line) return null;
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function permissionAsk(payload: HookPayload): string {
	const input = payload.tool_input as { command?: unknown } | undefined;
	if (typeof input?.command === "string")
		return oneLine(`wants to run ${input.command}`) as string;
	return payload.tool_name
		? `wants to use ${payload.tool_name}`
		: "needs permission";
}

/**
 * Applies one hook event to a session. Pure: returns the fields that change.
 * Archived is sticky; the master (milestone 2) decides finished vs idle after Stop.
 * Claude exiting is reported by the agent's wrapper, not by SessionEnd.
 * A turn that ends while subagents still run (background agents) stays working:
 * Claude resumes the turn when they report back.
 */
export function reduceHook(
	session: Session,
	kind: HookKind,
	payload: HookPayload,
): Partial<Session> {
	const patch: Partial<Session> = {};
	if (payload.transcript_path) patch.transcriptPath = payload.transcript_path;
	if (payload.session_id) patch.claudeSessionId = payload.session_id;
	if (session.status === "archived") return patch;

	switch (kind) {
		case "SessionStart":
			patch.status = "idle";
			patch.ask = null;
			patch.waitingOn = null;
			if (session.subagents.length) patch.subagents = [];
			break;
		case "UserPromptSubmit":
			patch.status = "working";
			patch.ask = null;
			patch.waitingOn = null;
			patch.lastPrompt = oneLine(payload.prompt);
			// A restart note has been seen once the user carries on.
			if (session.exitNote) patch.exitNote = null;
			// The previous reply is older than this prompt now.
			patch.lastAssistantMessage = null;
			break;
		// PreToolUse comes before the permission check, so it never ends a
		// wait; PostToolUse means the tool ran, an approved one included.
		case "PreToolUse":
			resume(session, patch, false);
			break;
		case "PostToolUse":
			resume(session, patch, true);
			break;
		case "SubagentStart":
			if (payload.agent_id)
				patch.subagents = [
					...session.subagents.filter((id) => id !== payload.agent_id),
					payload.agent_id,
				];
			resume(session, patch, false);
			break;
		case "SubagentStop":
			if (payload.agent_id && session.subagents.includes(payload.agent_id))
				patch.subagents = session.subagents.filter(
					(id) => id !== payload.agent_id,
				);
			break;
		case "PermissionRequest":
			patch.status = "waiting";
			patch.ask = permissionAsk(payload);
			patch.waitingOn = "permission";
			break;
		case "Notification": {
			const type = payload.notification_type;
			const blocking = type
				? WAITING_NOTIFICATIONS.has(type)
				: /permission|needs your/i.test(payload.message ?? "");
			if (blocking) {
				patch.status = "waiting";
				patch.waitingOn =
					type === "permission_prompt" ||
					(!type && /permission/i.test(payload.message ?? ""))
						? "permission"
						: "question";
				// A PermissionRequest just before it says more than the generic message.
				if (session.status !== "waiting" || !session.ask)
					patch.ask = oneLine(payload.message) ?? "needs you";
			}
			break;
		}
		case "Stop":
			patch.status = session.subagents.length ? "working" : "idle";
			patch.ask = null;
			patch.waitingOn = null;
			patch.lastAssistantMessage = oneLine(
				payload.last_assistant_message,
				REPLY_MAX,
			);
			break;
		// Not dead yet: the agent's wrapper reports the exit, and the daemon
		// restarts claude or ends the session (ADR 0044).
		case "SessionEnd":
			patch.ask = null;
			patch.waitingOn = null;
			if (session.subagents.length) patch.subagents = [];
			break;
	}
	return patch;
}

/**
 * Activity seen (a tool call, a subagent): back to working from idle or done,
 * and from waiting when it shows the wait is over.
 */
function resume(
	session: Session,
	patch: Partial<Session>,
	endsWait: boolean,
): void {
	const quiet = session.status === "idle" || session.status === "done";
	if (!quiet && !(endsWait && session.status === "waiting")) return;
	patch.status = "working";
	patch.ask = null;
	patch.waitingOn = null;
}

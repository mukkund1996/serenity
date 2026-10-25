import type { HookKind, HookPayload, Session } from "./domain";

/** Notification types that mean the agent is blocked on the user. */
const WAITING_NOTIFICATIONS = new Set([
	"permission_prompt",
	"elicitation_dialog",
	"elicitation_url_dialog",
	"agent_needs_input",
]);

const ONE_LINE_MAX = 200;

/** Enough of the agent's reply for the summarizer; cards cut it further. */
const REPLY_MAX = 2000;

function oneLine(text: string | undefined, max = ONE_LINE_MAX): string | null {
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
			break;
		case "UserPromptSubmit":
			patch.status = "working";
			patch.ask = null;
			patch.waitingOn = null;
			patch.lastPrompt = oneLine(payload.prompt);
			// The previous reply is older than this prompt now.
			patch.lastAssistantMessage = null;
			break;
		case "PostToolUse":
			if (session.status === "waiting" || session.status === "idle") {
				patch.status = "working";
				patch.ask = null;
				patch.waitingOn = null;
			}
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
			patch.status = "idle";
			patch.ask = null;
			patch.waitingOn = null;
			patch.lastAssistantMessage = oneLine(
				payload.last_assistant_message,
				REPLY_MAX,
			);
			break;
		case "SessionEnd":
			patch.status = "dead";
			patch.ask = null;
			patch.waitingOn = null;
			break;
	}
	return patch;
}

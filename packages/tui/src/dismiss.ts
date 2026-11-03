import type {
	MasterPermission,
	Session,
	SlackItem,
	Suggestion,
} from "@serenity/core";

/**
 * What x does (ADR 0057). On the master it only ever takes the selected
 * NEEDS YOU or queue item out of the list; on a card it asks to clean the
 * session up. The two never mix: a NEEDS YOU item is never cleaned up.
 */
export type XAction =
	| { kind: "slack"; item: SlackItem }
	| { kind: "queued"; suggestion: Suggestion }
	| { kind: "permission"; permission: MasterPermission }
	| { kind: "session"; session: Session }
	| { kind: "cleanup"; session: Session }
	| { kind: "none" };

export function xAction(at: {
	/** Focus is on the master (its NEEDS YOU, queue, rows), not a card. */
	onMaster: boolean;
	slackItem: SlackItem | null;
	queued: Suggestion | null;
	permission: MasterPermission | null;
	/** The selected NEEDS YOU session on the master, or the focused card. */
	session: Session | null;
}): XAction {
	if (!at.onMaster)
		return at.session
			? { kind: "cleanup", session: at.session }
			: { kind: "none" };
	if (at.slackItem) return { kind: "slack", item: at.slackItem };
	if (at.queued) return { kind: "queued", suggestion: at.queued };
	if (at.permission) return { kind: "permission", permission: at.permission };
	if (at.session) return { kind: "session", session: at.session };
	return { kind: "none" };
}

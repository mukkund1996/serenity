import { basename, join } from "node:path";
import type {
	HandoverDoc,
	HandoverPurpose,
	MasterMessage,
	Session,
} from "./domain";

/**
 * Handover docs (ADR 0049): a session's agent writes what the next person
 * needs into its own worktree, where writing needs no extra permission, and
 * serenity copies it into its home once the agent's turn ends.
 */

/** serenity's folder in a session's worktree; it ignores itself in git. */
export const HANDOVER_DIR = ".serenity";

/** Where a session's agent writes its handover doc. */
export function handoverDraftPath(session: Session): string {
	return join(session.cwd, HANDOVER_DIR, "handover.md");
}

/** The copy's file name: the session and when it was copied, e.g. api-auth-20261030-141502.md. */
export function handoverFileName(session: Session, at: number): string {
	const stamp = new Date(at)
		.toISOString()
		.replace(/[-:]/g, "")
		.replace("T", "-")
		.slice(0, 15);
	return `${session.name}-${stamp}.md`;
}

/** What the session's agent is asked to write; typed into it like the user's message. */
export function handoverRequest(
	session: Session,
	follow: string | null,
): string {
	return [
		`serenity asks for a handover doc: write ${handoverDraftPath(session)} (replace it if it exists) so someone who knows nothing of this session can carry on.`,
		"Markdown, with these sections: Goal; State (what is done, what is not, what is in flight); Decisions (and why); Open questions; Key files, branches and PRs (with paths, names and links); Next steps.",
		follow
			? `The next steps are for this follow-up: ${follow}`
			: "The next steps are for whoever continues this work.",
		"Write only that file and change nothing else. Reply with its path when it's written.",
	].join("\n");
}

/**
 * Whether a doc still says where the session is: it has replied nothing
 * since the doc was copied, and is not working on something new.
 */
export function freshHandover(
	doc: HandoverDoc | undefined,
	session: Session,
): doc is HandoverDoc {
	return (
		!!doc &&
		doc.sessionId === session.id &&
		session.status !== "working" &&
		doc.reply === session.lastAssistantMessage
	);
}

/** A follow-up session's first prompt: the master's prompt, then the doc it carries on from. */
export function handoverPrompt(
	prompt: string,
	from: string,
	doc: string,
): string {
	return [
		prompt,
		"",
		`Handover from session ${from}, which worked on this before you:`,
		"",
		"<handover>",
		doc.trim(),
		"</handover>",
	].join("\n");
}

/** What the chat is told once the doc is copied. */
export function handoverReadyMessage(
	session: Session,
	path: string,
	purpose: HandoverPurpose,
	follow: string | null,
): string {
	return [
		`serenity: ${session.name} wrote its handover doc: ${path}`,
		purpose === "copy"
			? `For the user's @copy: call mcp__serenity__create_session now, with handover set to that path, a new name, and a prompt for the follow-up: ${follow ?? "carry on with this work"}. serenity adds the doc to the prompt, so don't paste it. Then tell the user the doc's path and the new session's name.`
			: "For the user's @handover: give them the path, and a line on what the doc says if they asked. Read it with Read if you need to.",
		"This message is from serenity, not the user.",
	].join("\n");
}

/** What the chat is told when the turn ended with no new doc. */
export function handoverMissingMessage(session: Session): string {
	return [
		`serenity: ${session.name} finished its turn without writing ${handoverDraftPath(session)}.`,
		"Tell the user in one sentence, with what its last reply says (session_status has it). Don't start a session or ask it again unless they want to.",
		"This message is from serenity, not the user.",
	].join("\n");
}

/**
 * Whether a share of this handover doc on Slack was confirmed in the chat
 * (ADR 0049), like a message (0030): the user's latest message answers a
 * master reply that showed the file's name, the channel ID and the comment.
 */
export function confirmedFileShare(
	conversation: readonly MasterMessage[],
	share: { path: string; channelId: string; comment: string | null },
): boolean {
	const last = conversation.at(-1);
	const draft = conversation.at(-2);
	if (last?.from !== "you" || draft?.from !== "master") return false;
	const shown = squash(draft.text);
	return (
		shown.includes(basename(share.path)) &&
		shown.includes(share.channelId) &&
		(!share.comment || shown.includes(squash(share.comment)))
	);
}

function squash(text: string): string {
	return text
		.replace(/^[ \t]*>[ \t]?/gm, "")
		.replace(/\s+/g, " ")
		.trim();
}

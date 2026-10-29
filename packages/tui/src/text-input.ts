/**
 * Splits a chunk of typed or pasted input at its first line break. tmux and
 * terminals can deliver "text\r" as one chunk, in which case Ink never reports
 * a separate Return key.
 */
export function splitAtNewline(input: string): {
	text: string;
	submit: boolean;
} {
	const at = input.search(/[\r\n]/);
	if (at === -1) return { text: input, submit: false };
	return { text: input.slice(0, at), submit: true };
}

/**
 * Whether a key starts a new line in a multi-line input instead of sending
 * it (ADR 0038): Shift+Enter, which tmux passes to the map as a CSI u key;
 * Alt+Enter; and Ctrl+J, which every terminal sends as a bare line feed.
 */
export function isNewlineKey(
	input: string,
	key: { return: boolean; shift: boolean; meta: boolean },
): boolean {
	return (key.return && (key.shift || key.meta)) || input === "\n";
}

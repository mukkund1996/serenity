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

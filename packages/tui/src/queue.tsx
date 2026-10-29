import type { Session, Suggestion } from "@serenity/core";
import { Box, Text } from "ink";
import { Chips, FieldLine, SectionHeader, Selector } from "./components";
import { NEED_INDENT, queueLines } from "./master-layout";
import type { Field } from "./text-input";
import { QUEUE_COLOR } from "./theme";

/** Element id prefix of a queued reply in the master (ADR 0040). */
export const QUEUE_ROW = "q:";

export interface QueuedReply {
	suggestion: Suggestion;
	session: Session;
}

/**
 * The master's queue (ADR 0040): replies its chat wants to send, one line
 * each, the target session and a preview. Enter shows the whole message;
 * y sends it, e edits it, n drops it.
 */
export function QueueSection({
	queue,
	window,
	selected,
	expanded,
	reply,
	inner,
}: {
	queue: QueuedReply[];
	window: { start: number; count: number; hidden: number };
	selected: string | null;
	/** The suggestion shown in full, or null. */
	expanded: string | null;
	/** The selected reply's text being edited (e), or null. */
	reply: Field | null;
	inner: number;
}) {
	if (!queue.length) return null;
	const shown = queue.slice(window.start, window.start + window.count);
	return (
		<>
			<SectionHeader
				label={`QUEUE ${queue.length}`}
				width={inner}
				color={QUEUE_COLOR}
			/>
			{shown.map(({ suggestion, session }) => {
				const on = selected === `${QUEUE_ROW}${suggestion.id}`;
				const text = suggestion.text ?? "";
				return (
					<Box key={suggestion.id} flexDirection="column">
						<Box justifyContent="space-between">
							<Text wrap="truncate">
								<Selector on={on} />
								<Text color={QUEUE_COLOR}>→ </Text>
								<Text color={on ? "whiteBright" : undefined} bold={on}>
									{session.name}
								</Text>
								{expanded === suggestion.id ? null : (
									<Text color="gray"> {text.replace(/\s+/g, " ")}</Text>
								)}
							</Text>
							<Box flexShrink={0} marginLeft={1}>
								<Chips keys="yen" />
							</Box>
						</Box>
						{on && reply !== null ? (
							<Box paddingLeft={NEED_INDENT}>
								<FieldLine field={reply} width={inner - NEED_INDENT} />
							</Box>
						) : expanded === suggestion.id ? (
							queueLines(text, inner).map((line, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
								<Box key={i} paddingLeft={NEED_INDENT}>
									<Text color="white">{line || " "}</Text>
								</Box>
							))
						) : null}
					</Box>
				);
			})}
			{window.hidden > 0 ? (
				<Text color="gray">+{window.hidden} more · ↑↓ scroll</Text>
			) : null}
		</>
	);
}

import type {
	Canvas,
	Color,
	MasterMessage,
	MasterPermission,
	MasterState,
	ReviewRequest,
	Session,
	SlackItem,
	SlackState,
	SlackSuggestion,
	Suggestion,
} from "@serenity/core";
import {
	actionLine,
	commandHint,
	prLine,
	slackSuggestionLine,
	suggestionAction,
} from "@serenity/core";
import { Box, Text } from "ink";
import { type ReactNode, useEffect, useState } from "react";
import { type InputRow, inputRows, PROMPT_W } from "./master-input";
import {
	CONVERSATION_EMPTY,
	type ConversationWindow,
	clipLines,
	type MasterPlan,
	NEED_INDENT,
	needLines,
	SPEAKER_W,
	suggestionLines,
} from "./master-layout";
import { CURSOR, type Field, fieldWindow } from "./text-input";
import { age, askLine, BRAND_COLOR, cardText, glyph, nameColor } from "./theme";

const ink = (color: Color | undefined) =>
	color && color !== "default" ? color : undefined;

export function CanvasView({ canvas }: { canvas: Canvas }) {
	return (
		<Box
			flexDirection="column"
			width={canvas.width}
			height={canvas.height}
			flexShrink={1}
			minWidth={0}
			overflow="hidden"
		>
			{canvas.rows().map((runs, y) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
				<Text key={y} wrap="truncate">
					{runs.map((run, i) => (
						<Text
							// biome-ignore lint/suspicious/noArrayIndexKey: runs are positional
							key={i}
							color={ink(run.style.fg)}
							backgroundColor={ink(run.style.bg)}
							bold={run.style.bold}
							dimColor={run.style.dim}
							underline={run.style.underline}
						>
							{run.text}
						</Text>
					))}
				</Text>
			))}
		</Box>
	);
}

/** A key rendered like the design's .key chip. */
export function Key({ children }: { children: ReactNode }) {
	return (
		<Text color="whiteBright" bold>
			{children}
		</Text>
	);
}

/**
 * A one-row reply field (ADR 0042): "› " and the text on black, the
 * character under the cursor inverted, cut to `width` columns around it.
 */
export function FieldLine({ field, width }: { field: Field; width: number }) {
	const { before, at, after } = fieldWindow(field, width - PROMPT_W);
	return (
		<Text color="whiteBright" backgroundColor="black" wrap="truncate">
			› {before}
			{at === null ? CURSOR : <Text inverse>{at}</Text>}
			{after}
		</Text>
	);
}

/** The ◈ serenity wordmark in the header, coloured as on getserenity.dev. */
export function Brand() {
	return (
		<Text bold>
			<Text color={BRAND_COLOR}>◈</Text>
			<Text color="whiteBright"> serenity</Text>
		</Text>
	);
}

/** A bordered box with its title sitting on the top border. */
export function TitledBox({
	title,
	titleColor,
	borderStyle,
	borderColor,
	width,
	right,
	fill,
	children,
}: {
	title: string;
	titleColor: Color;
	borderStyle: "round" | "single" | "double" | "bold";
	borderColor: Color;
	width: number;
	right?: ReactNode;
	/** Background for an overlay, so what is behind it does not show through. */
	fill?: Color;
	children: ReactNode;
}) {
	return (
		<Box position="relative" flexDirection="column" width={width}>
			<Box
				borderStyle={borderStyle}
				borderColor={ink(borderColor)}
				backgroundColor={ink(fill)}
				borderBackgroundColor={ink(fill)}
				flexDirection="column"
				paddingX={2}
				width={width}
			>
				{children}
			</Box>
			<Box position="absolute" marginLeft={2}>
				<Text color={ink(titleColor)} backgroundColor={ink(fill)} bold>
					{` ${title} `}
				</Text>
			</Box>
			{right ? (
				<Box
					position="absolute"
					width={width}
					justifyContent="flex-end"
					paddingRight={2}
				>
					{right}
				</Box>
			) : null}
		</Box>
	);
}

/** A section's heading on a filled chip, so it stands apart from its rows. */
export function SectionHeader({
	label,
	width,
	urgent = false,
	color,
}: {
	label: string;
	width: number;
	/** NEEDS YOU: yellow, like the header's count. */
	urgent?: boolean;
	/** The chip's own colour, as the queue's (ADR 0040). */
	color?: Color;
}) {
	const chip = ` ${label} `;
	const fill = color ?? (urgent ? "yellow" : "gray");
	return (
		<Box marginTop={1}>
			<Text
				backgroundColor={ink(fill)}
				color={fill === "gray" ? "whiteBright" : "black"}
				bold
			>
				{chip}
			</Text>
			<Text color="gray">
				{` ${"─".repeat(Math.max(0, width - chip.length - 1))}`}
			</Text>
		</Box>
	);
}

function SessionLine({ session }: { session: Session }) {
	const g = glyph(session.status);
	return (
		<Text wrap="truncate">
			{g ? <Text color={g.color}>{g.ch} </Text> : null}
			<Text color={ink(nameColor(session.status))}>{session.name}</Text>
			{session.watched ? <Text color="white"> ⚑</Text> : null}
		</Text>
	);
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** The spinner (ADR 0012): ticks only while the master is thinking; the pulse is the other animation (0039). */
function Spinner() {
	const [frame, setFrame] = useState(0);
	useEffect(() => {
		const timer = setInterval(
			() => setFrame((f) => (f + 1) % SPINNER.length),
			120,
		);
		return () => clearInterval(timer);
	}, []);
	return <Text color="magenta">{SPINNER[frame]}</Text>;
}

/**
 * The master's input: it grows to four lines. `text` is null until `i` (or
 * Enter on it) opens it. `mentions` is the @ list over it; `width` is the
 * panel's text width.
 */
function MasterInput({
	field,
	selected = false,
	mentions = null,
	width = 0,
}: {
	field: Field | null;
	selected?: boolean;
	mentions?: { names: string[]; selected: number } | null;
	width?: number;
}) {
	// Frame (2) and the prompt's "› " leave the rest of the row for text.
	const rows =
		field === null
			? []
			: inputRows(field.text, width - 2 - PROMPT_W, field.cursor);
	return (
		<Box flexDirection="column" marginTop={1}>
			{mentions?.names.map((name, i) => (
				<Text
					key={name}
					wrap="truncate"
					color={i === mentions.selected ? "whiteBright" : "white"}
					bold={i === mentions.selected}
				>
					{i === mentions.selected ? "▸ " : "  "}@{name}
					{commandHint(name) ? (
						<Text color="gray"> {commandHint(name)}</Text>
					) : null}
				</Text>
			))}
			<Box
				flexDirection="column"
				borderStyle={selected ? "bold" : "single"}
				borderColor={field === null && !selected ? "gray" : "whiteBright"}
			>
				{field === null ? (
					<Text wrap="truncate-start">
						<Text color="magenta">› </Text>
						<Text color="gray">message master…</Text>
					</Text>
				) : (
					rows.map((row, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity; they are redrawn as a whole
						<Text key={i} wrap="truncate-end" color="whiteBright">
							<Text color="magenta">{i === 0 ? "› " : "  "}</Text>
							<RowWithCursor row={row} />
						</Text>
					))
				)}
			</Box>
		</Box>
	);
}

/** An input row, the character under the cursor inverted, or CURSOR after the text. */
function RowWithCursor({ row }: { row: InputRow }) {
	if (row.cursor === null) return <>{row.text}</>;
	const chars = [...row.text];
	return (
		<>
			{chars.slice(0, row.cursor).join("")}
			{row.cursor < chars.length ? (
				<Text inverse>{chars[row.cursor]}</Text>
			) : (
				CURSOR
			)}
			{chars.slice(row.cursor + 1).join("")}
		</>
	);
}

/** The y / e / n chips after a suggestion; y is the primary key. */
export function Chips({ keys }: { keys: string }) {
	const [primary, ...rest] = [...keys];
	return (
		<Text>
			<Text backgroundColor="magenta" color="black" bold>
				{` ${primary} `}
			</Text>
			{rest.map((k) => (
				<Text key={k} color="gray">
					{" "}
					{k}
				</Text>
			))}
		</Text>
	);
}

export function Selector({ on }: { on: boolean }) {
	return <Text color="whiteBright">{on ? "▸ " : "  "}</Text>;
}

/**
 * One NEEDS YOU item (design): glyph and name, what it needs, and the ◆
 * suggestion as what y does to whom, in full while selected (ADR 0050).
 */
function NeedItem({
	session,
	suggestion,
	selected,
	reply,
	inner,
	first,
}: {
	session: Session;
	suggestion: Suggestion | undefined;
	selected: boolean;
	/** Reply being typed to this session, shown under it while selected. */
	reply: Field | null;
	inner: number;
	/** The first item shown; the others are spaced from the one above. */
	first: boolean;
}) {
	const g = glyph(session.status);
	const label = suggestion
		? suggestionLines(
				actionLine(suggestionAction(suggestion, session)),
				inner,
				selected,
			)
		: [];
	return (
		<Box flexDirection="column" marginTop={first ? 0 : 1}>
			<Text wrap="truncate">
				<Selector on={selected} />
				{g ? <Text color={g.color}>{g.ch} </Text> : null}
				<Text
					color={selected ? "whiteBright" : ink(nameColor(session.status))}
					bold={selected}
				>
					{session.name}
				</Text>
				{session.watched ? <Text color="white"> ⚑</Text> : null}
			</Text>
			{needLines(askLine(session), inner).map((line, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
				<Box key={i} paddingLeft={NEED_INDENT}>
					<Text color={session.status === "waiting" ? "white" : "gray"}>
						{line}
					</Text>
				</Box>
			))}
			{label.map((line, i) => (
				<Box
					// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
					key={i}
					paddingLeft={NEED_INDENT}
					justifyContent="space-between"
				>
					<Text wrap="truncate">
						<Text color="magenta">{i ? "  " : "◆ "}</Text>
						{line}
					</Text>
					{i === 0 ? (
						<Box flexShrink={0} marginLeft={1}>
							<Chips keys="yen" />
						</Box>
					) : null}
				</Box>
			))}
			{selected && reply !== null ? (
				<Box paddingLeft={NEED_INDENT}>
					<FieldLine field={reply} width={inner - NEED_INDENT} />
				</Box>
			) : null}
		</Box>
	);
}

/** The master asking to use a tool (ADR 0008): top of NEEDS YOU, y allow / n deny. */
function PermissionItem({
	permission,
	selected,
	inner,
	first,
}: {
	permission: MasterPermission;
	selected: boolean;
	inner: number;
	first: boolean;
}) {
	return (
		<Box flexDirection="column" marginTop={first ? 0 : 1}>
			<Box justifyContent="space-between">
				<Text wrap="truncate">
					<Selector on={selected} />
					<Text color="magenta">◆ </Text>
					<Text color={selected ? "whiteBright" : undefined} bold={selected}>
						master wants to use {permission.toolName}
					</Text>
				</Text>
				<Box flexShrink={0} marginLeft={1}>
					<Chips keys="yn" />
				</Box>
			</Box>
			{needLines(permission.detail, inner).map((line, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
				<Box key={i} paddingLeft={NEED_INDENT}>
					<Text color="gray">{line}</Text>
				</Box>
			))}
		</Box>
	);
}

/** The conversation's window (ADR 0041): "↑ N more" above it, "↓ N newer" below once scrolled back; both grey, keys included (0042). */
function Conversation({
	messages,
	window,
}: {
	messages: MasterMessage[];
	window: ConversationWindow;
}) {
	const shown = messages.slice(window.start, window.end);
	if (!shown.length) {
		const [before, after] = CONVERSATION_EMPTY.split(" i ");
		return (
			<Text color="gray">
				{before} <Key>i</Key> {after}
			</Text>
		);
	}
	return (
		<>
			{window.older ? (
				<Text color="gray" wrap="truncate">
					↑ {window.older} more · PgUp
				</Text>
			) : null}
			{shown.map((m, i) => (
				<Box key={m.id} marginTop={i ? 1 : 0}>
					<Box width={SPEAKER_W} flexShrink={0}>
						{m.from === "you" ? (
							<Text color="cyan">you</Text>
						) : (
							<Text color="magenta">◆</Text>
						)}
					</Box>
					<Text color={m.from === "you" ? undefined : "white"} wrap="wrap">
						{clipLines(m.text, 4)}
					</Text>
				</Box>
			))}
			{window.newer ? (
				<Text color="gray" wrap="truncate">
					↓ {window.newer} newer · PgDn
				</Text>
			) : null}
		</>
	);
}

/** The master's input, as an element the arrow keys can select. */
export const MASTER_INPUT = "input";
/** Element id prefix of the master's review-request rows. */
export const REVIEW_ROW = "rv:";
/** Element id prefix of a Slack item in NEEDS YOU (ADR 0031). */
export const SLACK_NEED = "sl:";

/** A row with text on the left and a fixed part on the right. */
function Row({
	selected,
	children,
	right,
}: {
	selected: boolean;
	children: ReactNode;
	right: ReactNode;
}) {
	return (
		<Box justifyContent="space-between">
			<Text wrap="truncate">
				<Selector on={selected} />
				{children}
			</Text>
			<Box flexShrink={0} marginLeft={1}>
				{right}
			</Box>
		</Box>
	);
}

function PrTitle({
	number,
	title,
	selected,
}: {
	number: number;
	title: string;
	selected: boolean;
}) {
	return (
		<>
			<Text color="gray">#{number} </Text>
			<Text color={selected ? "whiteBright" : undefined} bold={selected}>
				{title}
			</Text>
		</>
	);
}

/** PRs waiting for the user's review, newest updated first. */
function ReviewSection({
	reviews,
	selected,
	width,
	now,
}: {
	reviews: ReviewRequest[];
	selected: string | null;
	width: number;
	now: number;
}) {
	return (
		<>
			<SectionHeader label={`REVIEW ${reviews.length}`} width={width} />
			{reviews.map((r) => {
				const on = selected === `${REVIEW_ROW}${r.number}`;
				return (
					<Row
						key={r.number}
						selected={on}
						right={
							<Text color="gray">
								{r.author ? `@${r.author} ` : ""}
								{age(r.updatedAt, now)}
							</Text>
						}
					>
						<PrTitle number={r.number} title={r.title} selected={on} />
					</Row>
				);
			})}
		</>
	);
}

/**
 * A Slack mention or DM in NEEDS YOU (ADR 0031): who wrote and where, its
 * age, what the user has to do, and the ◆ suggestion as what y does
 * (ADR 0024, 0050), in full while selected.
 */
function SlackNeedItem({
	item,
	suggestion,
	selected,
	reply,
	inner,
	first,
	now,
}: {
	item: SlackItem;
	suggestion: SlackSuggestion | undefined;
	selected: boolean;
	/** The suggestion's text being edited (e), or null. */
	reply: Field | null;
	inner: number;
	first: boolean;
	now: number;
}) {
	return (
		<Box flexDirection="column" marginTop={first ? 0 : 1}>
			<Row
				selected={selected}
				right={<Text color="gray">{age(item.at, now)}</Text>}
			>
				<Text color="yellow">@ </Text>
				<Text color={selected ? "whiteBright" : undefined} bold={selected}>
					{item.author}
				</Text>
				<Text color="gray">
					{item.reason === "dm" ? " · dm" : ` in ${item.channel}`}
				</Text>
			</Row>
			{needLines(item.action, inner).map((line, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
				<Box key={i} paddingLeft={NEED_INDENT}>
					<Text color="white">{line}</Text>
				</Box>
			))}
			{suggestion ? (
				<SlackSuggestionLine
					suggestion={suggestion}
					reply={selected ? reply : null}
					inner={inner}
					full={selected}
				/>
			) : null}
		</Box>
	);
}

/** The master's ◆ suggestion for a Slack item: y e n while pending, else what it waits on. */
function SlackSuggestionLine({
	suggestion,
	reply,
	inner,
	full,
}: {
	suggestion: SlackSuggestion;
	reply: Field | null;
	inner: number;
	/** All of its text, not the first two lines. */
	full: boolean;
}) {
	if (reply !== null)
		return (
			<Box paddingLeft={NEED_INDENT}>
				<FieldLine field={reply} width={inner - NEED_INDENT} />
			</Box>
		);
	const pending = suggestion.status === "pending";
	return (
		<>
			{suggestionLines(slackSuggestionLine(suggestion), inner, full).map(
				(line, i) => (
					<Box
						// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
						key={i}
						paddingLeft={NEED_INDENT}
						justifyContent="space-between"
					>
						<Text wrap="truncate" color={pending ? undefined : "gray"}>
							<Text color="magenta">{i ? "  " : "◆ "}</Text>
							{line}
						</Text>
						{i === 0 && pending ? (
							<Box flexShrink={0} marginLeft={1}>
								<Chips keys="yen" />
							</Box>
						) : null}
					</Box>
				),
			)}
		</>
	);
}

/** Order of the counts: as cards sort inside a topic. */
const COUNTED = [
	["waiting", "waiting"],
	["working", "working"],
	["idle", "idle"],
	["done", "done"],
	["dead", "ended"],
] as const;

/** Counts of the sessions on the map, as the header's badges. */
export function SessionCounts({ sessions }: { sessions: Session[] }) {
	const counts = COUNTED.map(([status, word]) => ({
		status,
		word,
		n: sessions.filter((s) => s.status === status).length,
	})).filter((c) => c.n > 0);
	return (
		<Text wrap="truncate">
			{counts.map((c, i) => {
				const g = glyph(c.status);
				return (
					<Text key={c.status}>
						{i ? <Text color="gray"> · </Text> : null}
						{g ? <Text color={g.color}>{g.ch} </Text> : null}
						<Text color={ink(nameColor(c.status))}>
							{c.n} {c.word}
						</Text>
					</Text>
				);
			})}
		</Text>
	);
}

/**
 * Master panel in the topics zoom: NEEDS YOU, the GitHub overview that
 * fits (`plan`), the latest exchange, the input. When it is
 * the focused node its frame turns heavy white and `selected` (a `perm:<id>`,
 * a session id, a PR row, or MASTER_INPUT) carries the cursor.
 */
export function MasterPanel({
	width,
	sessions,
	needs,
	suggestions,
	permissions,
	conversation,
	master,
	calmTopics,
	plan,
	slack,
	focused,
	selected,
	input,
	mentions,
	reply,
	queue = null,
	pulse = null,
}: {
	width: number;
	sessions: Session[];
	needs: Session[];
	suggestions: Suggestion[];
	permissions: MasterPermission[];
	conversation: MasterMessage[];
	master: MasterState;
	calmTopics: number;
	plan: MasterPlan;
	slack: SlackState | null;
	focused: boolean;
	selected: string | null;
	input: Field | null;
	mentions: { names: string[]; selected: number } | null;
	reply: Field | null;
	/** The master's queue section (ADR 0040), drawn under NEEDS YOU. */
	queue?: ReactNode;
	/** The glow's colour while a session's answer lights it (ADR 0039, 0042). */
	pulse?: Color | null;
}) {
	const inner = width - 6;
	const now = Date.now();
	const slackItems = slack?.items ?? [];
	const count = needs.length + permissions.length + slackItems.length;
	const items = [
		...permissions.map((p) => ({ kind: "permission" as const, p })),
		...needs.map((s) => ({ kind: "session" as const, s })),
		...slackItems.map((m) => ({ kind: "slack" as const, m })),
	];
	const shown = items.slice(
		plan.needs.start,
		plan.needs.start + plan.needs.count,
	);
	const hiddenCount = plan.needs.hidden;
	const slackError = slack?.error ? (
		<Text color="yellow" wrap="truncate">
			{slack.error}
		</Text>
	) : null;
	const needsYou =
		count > 0 ? (
			<>
				<SectionHeader label={`NEEDS YOU ${count}`} width={inner} urgent />
				{shown.map((item, i) =>
					item.kind === "permission" ? (
						<PermissionItem
							key={item.p.id}
							permission={item.p}
							selected={selected === `perm:${item.p.id}`}
							inner={inner}
							first={i === 0}
						/>
					) : item.kind === "slack" ? (
						<SlackNeedItem
							key={item.m.id}
							item={item.m}
							suggestion={slack?.suggestions.find(
								(g) => g.itemId === item.m.id,
							)}
							selected={selected === `${SLACK_NEED}${item.m.id}`}
							reply={reply}
							inner={inner}
							first={i === 0}
							now={now}
						/>
					) : (
						<NeedItem
							key={item.s.id}
							session={item.s}
							suggestion={suggestions.find((g) => g.sessionId === item.s.id)}
							selected={selected === item.s.id}
							reply={reply}
							inner={inner}
							first={i === 0}
						/>
					),
				)}
				{hiddenCount > 0 ? (
					<Text color="gray">+{hiddenCount} more · ↑↓ scroll</Text>
				) : null}
			</>
		) : null;
	const reviews = plan.reviews.length ? (
		<ReviewSection
			reviews={plan.reviews}
			selected={selected}
			width={inner}
			now={now}
		/>
	) : null;
	return (
		<TitledBox
			title="◆ master"
			titleColor="magenta"
			borderStyle={focused ? "bold" : "round"}
			borderColor={pulse ?? (focused ? "whiteBright" : "magenta")}
			width={width}
			right={master.status === "thinking" ? <Spinner /> : undefined}
		>
			{sessions.length === 0 ? (
				<>
					<Text color="gray">No sessions yet.</Text>
					<Text> </Text>
					<Text>
						Press <Key>n</Key> to start your first session.
					</Text>
					{slackError}
					{needsYou}
					{queue}
					{reviews}
				</>
			) : (
				<>
					<Text wrap="truncate">
						{master.error ? (
							<Text color="red">{master.error}</Text>
						) : count > 0 ? (
							<Text color="yellow">
								{count} {count === 1 ? "thing needs" : "things need"} you
							</Text>
						) : (
							<Text color="gray">nothing needs you</Text>
						)}
						{!master.error && calmTopics > 0 ? (
							<Text color="gray">
								{" "}
								· {calmTopics} {calmTopics === 1 ? "topic" : "topics"} calm
							</Text>
						) : null}
					</Text>
					{slackError}
					{needsYou}
					{queue}
					{reviews}
					<SectionHeader label="CONVERSATION" width={inner} />
					<Conversation messages={conversation} window={plan.conversation} />
				</>
			)}
			<MasterInput
				field={input}
				selected={selected === MASTER_INPUT}
				mentions={mentions}
				width={inner}
			/>
		</TitledBox>
	);
}

/** Floating master in the session zoom (design screen 3). */
export function SessionMaster({
	width,
	session,
	suggestion,
	others,
}: {
	width: number;
	session: Session;
	suggestion: Suggestion | undefined;
	others: Session[];
}) {
	const inner = width - 6;
	return (
		<TitledBox
			title="◆ master"
			titleColor="magenta"
			borderStyle="round"
			borderColor="magenta"
			width={width}
		>
			{others.length > 0 ? (
				<Text color="yellow">
					{others.length} other{" "}
					{others.length === 1 ? "session needs" : "sessions need"} you
				</Text>
			) : (
				<Text color="gray">nothing else needs you</Text>
			)}
			<SectionHeader label="ABOUT THIS SESSION" width={inner} />
			<Text color="gray" wrap="truncate">
				{prLine(session)}
			</Text>
			<Text color="white">{cardText(session)}</Text>
			{suggestion ? (
				<Box marginTop={1}>
					<Text>
						<Text color="magenta">◆ </Text>
						{suggestion.label}
					</Text>
				</Box>
			) : null}
			{others.length > 0 ? (
				<>
					<SectionHeader
						label={`ALSO NEEDS YOU ${others.length}`}
						width={inner}
					/>
					{others.map((s) => (
						<SessionLine key={s.id} session={s} />
					))}
				</>
			) : null}
			<MasterInput field={null} />
		</TitledBox>
	);
}

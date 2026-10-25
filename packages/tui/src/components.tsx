import type {
	Canvas,
	Color,
	MasterMessage,
	MasterPermission,
	MasterState,
	Session,
	Suggestion,
} from "@serenity/core";
import { prLine } from "@serenity/core";
import { Box, Text } from "ink";
import { type ReactNode, useEffect, useState } from "react";
import { askLine, cardText, glyph, nameColor } from "./theme";

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

function SectionHeader({ label, width }: { label: string; width: number }) {
	return (
		<Box marginTop={1}>
			<Text color="whiteBright">{label} </Text>
			<Text color="gray">
				{"─".repeat(Math.max(0, width - label.length - 1))}
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

/** The one animation (ADR 0012): ticks only while the master is thinking. */
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

/** The master's input row; `text` is null until `g` (or Enter on it) opens it. */
function MasterInput({
	text,
	selected = false,
}: {
	text: string | null;
	selected?: boolean;
}) {
	return (
		<Box
			borderStyle={selected ? "bold" : "single"}
			borderColor={text === null && !selected ? "gray" : "whiteBright"}
			marginTop={1}
		>
			<Text wrap="truncate-start">
				<Text color="magenta">› </Text>
				{text === null ? (
					<Text color="gray">message master…</Text>
				) : (
					<Text color="whiteBright">{text}█</Text>
				)}
			</Text>
		</Box>
	);
}

/** The y / e / n chips after a suggestion; y is the primary key. */
function Chips({ keys }: { keys: string }) {
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

function Selector({ on }: { on: boolean }) {
	return <Text color="whiteBright">{on ? "▸ " : "  "}</Text>;
}

/** One NEEDS YOU item (design): glyph and name, what it needs, the ◆ suggestion. */
function NeedItem({
	session,
	suggestion,
	selected,
	replyText,
}: {
	session: Session;
	suggestion: Suggestion | undefined;
	selected: boolean;
	/** Reply being typed to this session, shown under it while selected. */
	replyText: string | null;
}) {
	const g = glyph(session.status);
	return (
		<Box flexDirection="column">
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
			<Box paddingLeft={4}>
				<Text color="gray" wrap="truncate">
					{askLine(session)}
				</Text>
			</Box>
			{suggestion ? (
				<Box paddingLeft={4} justifyContent="space-between">
					<Text wrap="truncate">
						<Text color="magenta">◆ </Text>
						{suggestion.label}
					</Text>
					<Box flexShrink={0} marginLeft={1}>
						<Chips keys="yen" />
					</Box>
				</Box>
			) : null}
			{selected && replyText !== null ? (
				<Box paddingLeft={4}>
					<Text
						color="whiteBright"
						backgroundColor="black"
						wrap="truncate-start"
					>
						› {replyText}█
					</Text>
				</Box>
			) : null}
		</Box>
	);
}

/** The master asking to use a tool (ADR 0008): top of NEEDS YOU, y allow / n deny. */
function PermissionItem({
	permission,
	selected,
}: {
	permission: MasterPermission;
	selected: boolean;
}) {
	return (
		<Box flexDirection="column">
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
			<Box paddingLeft={4}>
				<Text color="gray" wrap="truncate">
					{permission.detail}
				</Text>
			</Box>
		</Box>
	);
}

function Conversation({ messages }: { messages: MasterMessage[] }) {
	if (!messages.length)
		return (
			<Text color="gray">
				Press <Key>g</Key> to ask the master about your sessions.
			</Text>
		);
	return (
		<>
			{messages.map((m, i) => (
				<Box key={m.id} marginTop={i ? 1 : 0}>
					<Box width={6} flexShrink={0}>
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
		</>
	);
}

/** Keeps a message to a few lines; the full history belongs behind M (v1.1). */
function clipLines(text: string, lines: number): string {
	const kept = text.split("\n").filter(Boolean).slice(0, lines).join("\n");
	return kept.length > 400 ? `${kept.slice(0, 399)}…` : kept;
}

/** How many NEEDS YOU items fit; the rest are summarised as "+N more". */
const MAX_NEED_ITEMS = 5;

/** The master's input, as an element the arrow keys can select. */
export const MASTER_INPUT = "input";

/**
 * Master panel in the topics zoom: NEEDS YOU, the latest exchange, the input.
 * When it is the focused node its frame turns heavy white and `selected`
 * (a `perm:<id>`, a session id, or MASTER_INPUT) carries the cursor.
 */
export function MasterPanel({
	width,
	sessions,
	needs,
	suggestions,
	permissions,
	conversation,
	master,
	calmCategories,
	focused,
	selected,
	inputText,
	replyText,
}: {
	width: number;
	sessions: Session[];
	needs: Session[];
	suggestions: Suggestion[];
	permissions: MasterPermission[];
	conversation: MasterMessage[];
	master: MasterState;
	calmCategories: number;
	focused: boolean;
	selected: string | null;
	inputText: string | null;
	replyText: string | null;
}) {
	const inner = width - 6;
	const count = needs.length + permissions.length;
	const items = [
		...permissions.map((p) => ({ kind: "permission" as const, p })),
		...needs.map((s) => ({ kind: "session" as const, s })),
	];
	// Slide the window so the selected item is always on screen.
	const at = items.findIndex((item) =>
		item.kind === "permission"
			? selected === `perm:${item.p.id}`
			: selected === item.s.id,
	);
	const start = Math.max(0, at - MAX_NEED_ITEMS + 1);
	const shown = items.slice(start, start + MAX_NEED_ITEMS);
	const hiddenCount = items.length - shown.length;
	return (
		<TitledBox
			title="◆ master"
			titleColor="magenta"
			borderStyle={focused ? "bold" : "round"}
			borderColor={focused ? "whiteBright" : "magenta"}
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
						{!master.error && calmCategories > 0 ? (
							<Text color="gray">
								{" "}
								· {calmCategories}{" "}
								{calmCategories === 1 ? "category" : "categories"} calm
							</Text>
						) : null}
					</Text>
					{count > 0 ? (
						<>
							<SectionHeader label={`NEEDS YOU ${count}`} width={inner} />
							{shown.map((item) =>
								item.kind === "permission" ? (
									<PermissionItem
										key={item.p.id}
										permission={item.p}
										selected={selected === `perm:${item.p.id}`}
									/>
								) : (
									<NeedItem
										key={item.s.id}
										session={item.s}
										suggestion={suggestions.find(
											(g) => g.sessionId === item.s.id,
										)}
										selected={selected === item.s.id}
										replyText={replyText}
									/>
								),
							)}
							{hiddenCount > 0 ? (
								<Text color="gray">+{hiddenCount} more · ↑↓ scroll</Text>
							) : null}
						</>
					) : null}
					<SectionHeader label="CONVERSATION" width={inner} />
					<Conversation messages={conversation.slice(-2)} />
				</>
			)}
			<MasterInput text={inputText} selected={selected === MASTER_INPUT} />
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
			<MasterInput text={null} />
		</TitledBox>
	);
}

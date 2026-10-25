import { basename } from "node:path";
import {
	type CreateSessionParams,
	groupCategories,
	needsYou,
	type Session,
} from "@serenity/core";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { useEffect, useMemo, useState } from "react";
import { CanvasView, Key, MasterPanel, SessionMaster } from "./components";
import { NewSessionDialog, ShortcutsPanel } from "./overlays";
import { splitAtNewline } from "./text-input";
import { drawTopics, moveFocus } from "./topics";
import { useDaemon } from "./use-daemon";

export const MIN_COLUMNS = 80;
export const MIN_ROWS = 24;

type Overlay = "new" | "help" | null;

export interface AppProps {
	home: string;
	repo: string;
	/** This TUI's tmux pane, needed to attach a session beside it. */
	tmuxPane: string | undefined;
}

export function App({ home, repo, tmuxPane }: AppProps) {
	const { exit } = useApp();
	const { columns, rows } = useWindowSize();
	const { state, connected, call } = useDaemon(home, repo);
	const [focusId, setFocusId] = useState<string | null>(null);
	const [replyText, setReplyText] = useState<string | null>(null);
	const [overlay, setOverlay] = useState<Overlay>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const sessions = state?.sessions ?? [];
	const attached =
		sessions.find((s) => s.id === state?.attachedSessionId) ?? null;
	const groups = useMemo(() => groupCategories(sessions), [sessions]);
	const needs = useMemo(() => needsYou(sessions), [sessions]);

	const bodyHeight = rows - 2;
	const masterWidth = Math.max(34, Math.min(56, columns - 52));
	const topics = useMemo(
		() =>
			drawTopics({
				width: Math.max(1, columns - masterWidth),
				height: Math.max(1, bodyHeight),
				masterRow: Math.floor(bodyHeight / 2),
				groups,
				focusId,
				replyText,
			}),
		[columns, masterWidth, bodyHeight, groups, focusId, replyText],
	);

	// Keep focus on a visible card.
	useEffect(() => {
		if (!topics.cards.some((c) => c.sessionId === focusId))
			setFocusId(topics.cards[0]?.sessionId ?? null);
	}, [topics, focusId]);

	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(null), 4000);
		return () => clearTimeout(timer);
	}, [notice]);

	const fail = (e: unknown) =>
		setNotice(e instanceof Error ? e.message : String(e));
	const focused = sessions.find((s) => s.id === focusId) ?? null;

	const cycleWaiting = (back: boolean) => {
		const waiting = needs.filter((s) => s.status === "waiting");
		if (!waiting.length) return;
		const at = waiting.findIndex((s) => s.id === focusId);
		const next =
			at === -1 ? 0 : (at + (back ? waiting.length - 1 : 1)) % waiting.length;
		setFocusId(waiting[next]?.id ?? null);
	};

	useInput(
		(input, key) => {
			if (attached) {
				if (key.escape || (key.ctrl && input === "g"))
					call("session.detach", { id: attached.id }).catch(fail);
				return;
			}
			if (replyText !== null) {
				const send = (text: string) => {
					if (focused && text.trim())
						call("session.reply", { id: focused.id, text }).catch(fail);
					setReplyText(null);
				};
				if (key.escape) return setReplyText(null);
				if (key.return) return send(replyText);
				if (key.backspace || key.delete)
					return setReplyText(replyText.slice(0, -1));
				if (input && !key.ctrl && !key.meta) {
					const { text, submit } = splitAtNewline(input);
					if (submit) return send(replyText + text);
					setReplyText(replyText + text);
				}
				return;
			}
			if (overlay === "help") {
				if (input === "?" || key.escape) setOverlay(null);
				return;
			}
			if (key.tab) return cycleWaiting(key.shift);
			const dir = { w: "up", s: "down", a: "left", d: "right" } as const;
			const move =
				dir[input as keyof typeof dir] ??
				(key.upArrow
					? "up"
					: key.downArrow
						? "down"
						: key.leftArrow
							? "left"
							: key.rightArrow
								? "right"
								: null);
			if (move) return setFocusId(moveFocus(topics.cards, focusId, move));
			if (input === "q") return exit();
			if (input === "?") return setOverlay("help");
			if (input === "n") return setOverlay("new");
			if (input === "i" && focused) return setReplyText("");
			if (key.return && focused) {
				if (!tmuxPane)
					return setNotice("attach needs serenity to run inside tmux");
				call("session.attach", { id: focused.id, clientPane: tmuxPane }).catch(
					fail,
				);
			}
		},
		{ isActive: overlay !== "new" },
	);

	const createSession = async (params: CreateSessionParams) => {
		const session = await call("session.create", params);
		setOverlay(null);
		setFocusId(session.id);
	};

	if (attached)
		return (
			<SessionZoom
				session={attached}
				sessions={sessions}
				columns={columns}
				rows={rows}
			/>
		);

	if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
		return (
			<Box
				width="100%"
				height={rows}
				alignItems="center"
				justifyContent="center"
				flexDirection="column"
			>
				<Text>Terminal too small.</Text>
				<Text color="gray">
					serenity needs at least {MIN_COLUMNS} × {MIN_ROWS}; this one is{" "}
					{columns} × {rows}.
				</Text>
			</Box>
		);
	}

	const calm = groups.filter((g) => g.attention === 0).length;
	return (
		<Box
			flexDirection="column"
			width="100%"
			height={rows}
			overflow="hidden"
			position="relative"
		>
			<Header
				repo={repo}
				needs={needs.length}
				connected={connected}
				zoom="topics"
			/>
			<Box height={bodyHeight}>
				<Box
					width={masterWidth}
					height={bodyHeight}
					flexDirection="column"
					justifyContent="center"
				>
					<MasterPanel
						width={masterWidth}
						sessions={sessions}
						needs={needs}
						calmCategories={calm}
					/>
				</Box>
				<CanvasView canvas={topics.canvas} />
			</Box>
			<Box width="100%" justifyContent="space-between" paddingX={2}>
				{notice ? (
					<Text color="red" wrap="truncate">
						{notice}
					</Text>
				) : (
					<Text color="gray">
						<Key>WASD</Key> move
					</Text>
				)}
				<Text color="gray">
					<Key>?</Key> shortcuts
				</Text>
			</Box>
			{overlay === "new" ? (
				<Box
					position="absolute"
					width="100%"
					height={rows}
					alignItems="center"
					justifyContent="center"
				>
					<NewSessionDialog
						repo={repo}
						onSubmit={createSession}
						onClose={() => setOverlay(null)}
					/>
				</Box>
			) : null}
			{overlay === "help" ? (
				<Box
					position="absolute"
					width="100%"
					height={rows - 1}
					alignItems="flex-end"
					justifyContent="flex-end"
				>
					<ShortcutsPanel />
				</Box>
			) : null}
		</Box>
	);
}

function Header({
	repo,
	needs,
	connected,
	zoom,
}: {
	repo: string;
	needs: number;
	connected: boolean;
	zoom: string;
}) {
	return (
		<Box
			width="100%"
			backgroundColor="black"
			justifyContent="space-between"
			paddingX={1}
		>
			<Text>
				<Text color="magenta" bold>
					◆ serenity
				</Text>
				<Text color="gray"> {basename(repo)}</Text>
			</Text>
			<Text>
				{!connected ? (
					<Text backgroundColor="red" color="black" bold>
						{" daemon down "}
					</Text>
				) : needs > 0 ? (
					<Text backgroundColor="yellow" color="black" bold>
						{` ${needs} need you `}
					</Text>
				) : null}
			</Text>
			<Text color="gray">zoom: {zoom}</Text>
		</Box>
	);
}

/** Session zoom (design screen 3): this pane is the left ⅓ beside the joined agent pane. */
function SessionZoom({
	session,
	sessions,
	columns,
	rows,
}: {
	session: Session;
	sessions: Session[];
	columns: number;
	rows: number;
}) {
	const others = needsYou(sessions).filter((s) => s.id !== session.id);
	// This pane is narrow; every line is clipped to it so nothing wraps or scrolls.
	return (
		<Box flexDirection="column" width="100%" height={rows} overflow="hidden">
			<Box
				width="100%"
				height={1}
				backgroundColor="black"
				justifyContent="space-between"
				paddingX={1}
			>
				<Box flexShrink={1} overflow="hidden">
					<Text wrap="truncate">
						<Text color="magenta" bold>
							◆ serenity
						</Text>
						<Text color="gray"> › {session.category ?? "unsorted"} › </Text>
						<Text>{session.name}</Text>
					</Text>
				</Box>
				<Box flexShrink={0} marginLeft={1}>
					<Text color="gray">
						<Key>Ctrl+g</Key> map
					</Text>
				</Box>
			</Box>
			<Box marginTop={1} paddingLeft={1}>
				<SessionMaster
					width={Math.min(60, columns - 2)}
					session={session}
					others={others}
				/>
			</Box>
		</Box>
	);
}

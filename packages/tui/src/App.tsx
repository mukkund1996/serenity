import { basename } from "node:path";
import {
	type CleanupPlan,
	type CreateSessionParams,
	groupTopics,
	type ImportCandidate,
	type MasterState,
	needsYou,
	type Session,
	type Suggestion,
} from "@serenity/core";
import {
	Box,
	type Key as InkKey,
	Text,
	useApp,
	useInput,
	useWindowSize,
} from "ink";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
	CanvasView,
	Key,
	MASTER_INPUT,
	MasterPanel,
	SessionMaster,
} from "./components";
import { openUrl } from "./open-url";
import {
	ConfirmDialog,
	ImportDialog,
	NewSessionDialog,
	RecentReplies,
	ShortcutsPanel,
} from "./overlays";
import { splitAtNewline } from "./text-input";
import {
	type CardElement,
	cardElements,
	drawTopics,
	moveFocus,
	type NodeBox,
	stepTopic,
} from "./topics";
import { useDaemon } from "./use-daemon";

export const MIN_COLUMNS = 80;
export const MIN_ROWS = 24;
/** Replies remembered for the recent-replies list (design 4a). */
const REPLY_HISTORY = 6;

type Overlay =
	| { kind: "new" }
	| { kind: "help" }
	| {
			kind: "confirm";
			sessionId: string;
			plan: CleanupPlan;
			/** Set when confirming a master suggestion rather than an `x`. */
			suggestionId: string | null;
			busy: boolean;
			error: string | null;
	  }
	| { kind: "replies"; selected: number }
	| { kind: "import"; candidates: ImportCandidate[] }
	| null;

export interface AppProps {
	home: string;
	repo: string;
	/** This TUI's tmux pane, needed to attach a session beside it. */
	tmuxPane: string | undefined;
}

const PERM = "perm:";
/** The master panel's node id; every other node is a session card. */
const MASTER = "master";

/** A text field's keys: backspace, typing, and Enter (also inside a pasted chunk). */
function editText(
	value: string,
	input: string,
	key: { backspace: boolean; delete: boolean; ctrl: boolean; meta: boolean },
): { value: string; submit: boolean } | null {
	if (key.backspace || key.delete)
		return { value: value.slice(0, -1), submit: false };
	if (!input || key.ctrl || key.meta) return null;
	const { text, submit } = splitAtNewline(input);
	return { value: value + text, submit };
}

/**
 * State that key handlers read through `ref`, which a set updates at once.
 * Ink delivers each stdin chunk to the last rendered handler, so `i` and the
 * text typed right after it can both arrive before React re-renders.
 */
function useLiveState<T>(
	initial: T,
): [T, (next: T) => void, { readonly current: T }] {
	const [value, setValue] = useState(initial);
	const ref = useRef(initial);
	const set = (next: T) => {
		ref.current = next;
		setValue(next);
	};
	return [value, set, ref];
}

export function App({ home, repo, tmuxPane }: AppProps) {
	const { exit } = useApp();
	const { columns, rows } = useWindowSize();
	const { state, connected, call } = useDaemon(home, repo);
	/** The focused node: MASTER or a session card's id (WASD). */
	const [node, setNode] = useState<string>(MASTER);
	/** The element selected inside the node (arrow keys); null means its first. */
	const [element, setElement] = useState<string | null>(null);
	const [replyText, setReplyText, replyRef] = useLiveState<string | null>(null);
	/** The suggestion whose reply is being edited (e), if any. */
	const [, setReplyEdit, replyEditRef] = useLiveState<string | null>(null);
	const [masterText, setMasterText, masterRef] = useLiveState<string | null>(
		null,
	);
	const [sentReplies, setSentReplies] = useState<string[]>([]);
	const [overlay, setOverlay] = useState<Overlay>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const sessions = state?.sessions ?? [];
	const suggestions = state?.suggestions ?? [];
	const permissions = state?.permissions ?? [];
	const master: MasterState = state?.master ?? { status: "idle", error: null };
	const attached =
		sessions.find((s) => s.id === state?.attachedSessionId) ?? null;
	const groups = useMemo(() => groupTopics(sessions), [sessions]);
	const needs = useMemo(
		() => needsYou(sessions, suggestions),
		[sessions, suggestions],
	);

	const suggestionFor = (id: string | undefined): Suggestion | undefined =>
		suggestions.find((g) => g.sessionId === id);
	const onMaster = node === MASTER;
	const card = onMaster ? null : (sessions.find((s) => s.id === node) ?? null);
	const cardSuggestion = suggestionFor(card?.id);

	/** What ↑↓ step through: the master's requests, NEEDS YOU and its input, or a card's rows. */
	const elements: string[] = onMaster
		? [
				...permissions.map((p) => `${PERM}${p.id}`),
				...needs.map((s) => s.id),
				MASTER_INPUT,
			]
		: cardElements(!!cardSuggestion);
	const selected =
		element && elements.includes(element) ? element : (elements[0] ?? null);
	const focusedPermission =
		onMaster && selected?.startsWith(PERM)
			? (permissions.find((p) => `${PERM}${p.id}` === selected) ?? null)
			: null;
	/** The session that y / e / n / i / o / f / x act on: the card, or the selected NEEDS YOU item. */
	const focused = onMaster
		? (sessions.find((s) => s.id === selected) ?? null)
		: card;
	const focusedSuggestion = suggestionFor(focused?.id);

	const bodyHeight = rows - 2;
	const masterWidth = Math.max(34, Math.min(56, columns - 52));
	const masterRow = Math.floor(bodyHeight / 2);
	const topics = useMemo(
		() =>
			drawTopics({
				width: Math.max(1, columns - masterWidth),
				height: Math.max(1, bodyHeight),
				masterRow,
				groups,
				focusId: card?.id ?? null,
				focusElement: (onMaster ? "card" : selected) as CardElement,
				focusSuggestion: cardSuggestion?.label ?? null,
				replyText: onMaster ? null : replyText,
			}),
		[
			columns,
			masterWidth,
			bodyHeight,
			masterRow,
			groups,
			card?.id,
			onMaster,
			selected,
			cardSuggestion?.label,
			replyText,
		],
	);
	/** The map's nodes in canvas cells; the master sits left of the canvas. */
	const nodes: NodeBox[] = [
		{ id: MASTER, x: -masterWidth, y: 0, w: masterWidth, h: bodyHeight },
		...topics.cards.map((c) => ({ ...c, id: c.sessionId })),
	];

	const focusNode = (id: string, at: string | null = null) => {
		setNode(id);
		setElement(at);
	};
	/** A session just created or imported, focused before the daemon reports it. */
	const arriving = useRef<string | null>(null);

	// Keep focus on a card that is still on the map; otherwise the master has it.
	useEffect(() => {
		if (node === MASTER || topics.cards.some((c) => c.sessionId === node))
			return;
		if (node === arriving.current && !sessions.some((s) => s.id === node))
			return;
		arriving.current = null;
		setNode(MASTER);
		setElement(null);
	}, [topics, node, sessions]);

	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(null), 4000);
		return () => clearTimeout(timer);
	}, [notice]);

	const fail = (e: unknown) =>
		setNotice(e instanceof Error ? e.message : String(e));

	/** Tab order: the master's permission requests, then NEEDS YOU. Focuses the master. */
	const cycleNeeds = (back: boolean) => {
		const order = [
			...permissions.map((p) => `${PERM}${p.id}`),
			...needs.map((s) => s.id),
		];
		if (!order.length) return;
		const at = onMaster ? order.indexOf(selected ?? "") : -1;
		const next =
			at === -1 ? 0 : (at + (back ? order.length - 1 : 1)) % order.length;
		focusNode(MASTER, order[next] ?? null);
	};

	const startReply = () => {
		setReplyEdit(null);
		setReplyText("");
		if (!onMaster) setElement("reply");
	};

	const attach = (session: Session) => {
		if (!tmuxPane) return setNotice("attach needs serenity to run inside tmux");
		call("session.attach", { id: session.id, clientPane: tmuxPane }).catch(
			fail,
		);
	};

	/** Enter acts on the selected element; on the card itself it attaches. */
	const activate = () => {
		if (onMaster) {
			if (selected === MASTER_INPUT) return setMasterText("");
			if (focused) attach(focused);
			return;
		}
		if (!card) return;
		switch (selected as CardElement) {
			case "pr":
				if (card.pr) openUrl(card.pr.url);
				else setNotice(`${card.name} has no PR yet`);
				return;
			case "suggestion":
				if (cardSuggestion) void accept(cardSuggestion, card);
				return;
			case "reply":
				return startReply();
			default:
				attach(card);
		}
	};

	const openConfirm = async (session: Session, suggestionId: string | null) => {
		try {
			const plan = await call("session.cleanupPlan", { id: session.id });
			setOverlay({
				kind: "confirm",
				sessionId: session.id,
				plan,
				suggestionId,
				busy: false,
				error: null,
			});
		} catch (e) {
			fail(e);
		}
	};

	/** y on a suggestion. A cleanup that would keep work behind asks first (4b). */
	const accept = async (suggestion: Suggestion, session: Session) => {
		if (suggestion.kind !== "cleanup") {
			call("suggestion.accept", { id: suggestion.id }).catch(fail);
			return;
		}
		try {
			const plan = await call("session.cleanupPlan", { id: session.id });
			if (plan.safe) await call("suggestion.accept", { id: suggestion.id });
			else
				setOverlay({
					kind: "confirm",
					sessionId: session.id,
					plan,
					suggestionId: suggestion.id,
					busy: false,
					error: null,
				});
		} catch (e) {
			fail(e);
		}
	};

	/** Leaves the reply input; on a card the selection returns to the card itself. */
	const endReply = () => {
		setReplyText(null);
		setReplyEdit(null);
		if (!onMaster) setElement(null);
	};

	const sendReply = (text: string) => {
		const target = focused;
		endReply();
		setOverlay(null);
		if (!target || !text.trim()) return;
		setSentReplies((list) =>
			[text, ...list.filter((r) => r !== text)].slice(0, REPLY_HISTORY),
		);
		const editing = replyEditRef.current;
		const sent = editing
			? call("suggestion.accept", { id: editing, text })
			: call("session.reply", { id: target.id, text });
		sent.catch(fail);
	};

	const recentReplies = (): string[] => {
		const pick =
			focusedSuggestion?.kind === "reply" ? focusedSuggestion.text : null;
		return [...new Set([pick, ...sentReplies].filter((r): r is string => !!r))];
	};

	useInput(
		function onKey(input: string, key: InkKey) {
			if (attached) {
				if (key.escape || (key.ctrl && input === "g"))
					call("session.detach", { id: attached.id }).catch(fail);
				return;
			}

			if (overlay?.kind === "confirm") {
				if (overlay.busy) return;
				if (input === "n" || key.escape) return setOverlay(null);
				if (input !== "y") return;
				setOverlay({ ...overlay, busy: true, error: null });
				const run = overlay.suggestionId
					? call("suggestion.accept", { id: overlay.suggestionId })
					: call("session.cleanup", { id: overlay.sessionId });
				run.then(
					() => setOverlay(null),
					(e: Error) =>
						setOverlay({ ...overlay, busy: false, error: e.message }),
				);
				return;
			}

			if (overlay?.kind === "replies") {
				const list = recentReplies();
				if (key.escape) return setOverlay(null);
				if (key.upArrow)
					return setOverlay({
						kind: "replies",
						selected: Math.max(0, overlay.selected - 1),
					});
				if (key.downArrow)
					return setOverlay({
						kind: "replies",
						selected: Math.min(list.length - 1, overlay.selected + 1),
					});
				if (key.return) return sendReply(list[overlay.selected] ?? "");
				setOverlay(null);
				const edit = editText(replyRef.current ?? "", input, key);
				if (edit) setReplyText(edit.value);
				return;
			}

			const reply = replyRef.current;
			if (reply !== null) {
				if (key.escape) return endReply();
				if (key.tab) {
					if (recentReplies().length)
						setOverlay({ kind: "replies", selected: 0 });
					return;
				}
				if (key.return) return sendReply(reply);
				const edit = editText(reply, input, key);
				if (!edit) return;
				if (edit.submit) return sendReply(edit.value);
				setReplyText(edit.value);
				return;
			}

			const toMaster = masterRef.current;
			if (toMaster !== null) {
				const send = (text: string) => {
					setMasterText(null);
					if (text.trim()) call("master.message", { repo, text }).catch(fail);
				};
				if (key.escape) return setMasterText(null);
				if (key.return) return send(toMaster);
				const edit = editText(toMaster, input, key);
				if (!edit) return;
				if (edit.submit) return send(edit.value);
				setMasterText(edit.value);
				return;
			}

			if (overlay?.kind === "help") {
				if (input === "?" || key.escape) setOverlay(null);
				return;
			}

			// Keys typed before a render arrive as one chunk ("ifinish\r" when the
			// text comes before i's reply box is listening); take them one by one.
			const keys = [...input];
			if (keys.length > 1 && !key.ctrl && !key.meta) {
				for (const k of keys) onKey(k, { ...key, return: k === "\r" });
				return;
			}

			if (key.tab) return cycleNeeds(key.shift);
			const dir = { w: "up", s: "down", a: "left", d: "right" } as const;
			const move = dir[input as keyof typeof dir];
			if (move) return focusNode(moveFocus(nodes, node, move) ?? MASTER);
			if (key.upArrow || key.downArrow) {
				const at = selected ? elements.indexOf(selected) : 0;
				const next = Math.max(
					0,
					Math.min(elements.length - 1, at + (key.upArrow ? -1 : 1)),
				);
				return setElement(elements[next] ?? null);
			}
			if (input === "[" || input === "]") {
				const id = stepTopic(groups, card?.id ?? null, input === "]" ? 1 : -1);
				if (id) focusNode(id);
				return;
			}

			if (focusedPermission) {
				if (input === "y" || input === "n")
					call("master.permission", {
						id: focusedPermission.id,
						allow: input === "y",
					}).catch(fail);
				if (input === "y" || input === "n") return;
			}

			switch (input) {
				case "q":
					return exit();
				case "?":
					return setOverlay({ kind: "help" });
				case "g":
					return setMasterText("");
				case "N":
					return setOverlay({ kind: "new" });
				case "I":
					call("session.discover", { repo }).then((candidates) => {
						if (candidates.length) setOverlay({ kind: "import", candidates });
						else setNotice("no other claude sessions running in tmux here");
					}, fail);
					return;
				case "n":
					// On a suggestion, n declines it; anywhere else it starts a session.
					if (focusedSuggestion)
						call("suggestion.decline", { id: focusedSuggestion.id }).catch(
							fail,
						);
					else setOverlay({ kind: "new" });
					return;
			}
			if (key.return) return activate();
			if (!focused) return;
			switch (input) {
				case "y":
					if (focusedSuggestion) void accept(focusedSuggestion, focused);
					else setNotice(`nothing to approve on ${focused.name}`);
					return;
				case "e":
					if (!focusedSuggestion) return;
					if (focusedSuggestion.kind === "reply") {
						setReplyEdit(focusedSuggestion.id);
						setReplyText(focusedSuggestion.text ?? "");
						if (!onMaster) setElement("reply");
					} else if (focusedSuggestion.kind === "cleanup") {
						void openConfirm(focused, focusedSuggestion.id);
					} else if (tmuxPane) {
						// Approve: inspect the prompt in the session first.
						call("session.attach", {
							id: focused.id,
							clientPane: tmuxPane,
						}).catch(fail);
					}
					return;
				case "o":
					if (focused.pr) openUrl(focused.pr.url);
					else setNotice(`${focused.name} has no PR yet`);
					return;
				case "f":
					call("session.watch", {
						id: focused.id,
						watched: !focused.watched,
					}).catch(fail);
					return;
				case "x":
					void openConfirm(focused, null);
					return;
				case "U":
					if (focused.tracking !== "observed")
						return setNotice(`${focused.name} already reports through hooks`);
					call("session.upgrade", { id: focused.id }).then(
						() => setNotice(`restarted ${focused.name} with full tracking`),
						fail,
					);
					return;
				case "i":
					return startReply();
			}
		},
		{ isActive: overlay?.kind !== "new" && overlay?.kind !== "import" },
	);

	const importSessions = async (claudeSessionIds: string[]) => {
		const adopted = await call("session.adopt", { repo, claudeSessionIds });
		setOverlay(null);
		if (adopted[0]) {
			arriving.current = adopted[0].id;
			focusNode(adopted[0].id);
		}
		setNotice(
			`imported ${adopted.length} ${adopted.length === 1 ? "session" : "sessions"}`,
		);
	};

	const createSession = async (params: CreateSessionParams) => {
		const session = await call("session.create", params);
		setOverlay(null);
		arriving.current = session.id;
		focusNode(session.id);
	};

	if (attached)
		return (
			<SessionZoom
				session={attached}
				sessions={sessions}
				suggestion={suggestionFor(attached.id)}
				suggestions={suggestions}
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
	const confirmSession =
		overlay?.kind === "confirm"
			? sessions.find((s) => s.id === overlay.sessionId)
			: undefined;
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
				needs={needs.length + permissions.length}
				connected={connected}
				masterError={!!master.error}
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
						suggestions={suggestions}
						permissions={permissions}
						conversation={state?.conversation ?? []}
						master={master}
						calmTopics={calm}
						focused={onMaster}
						selected={onMaster ? selected : null}
						inputText={masterText}
						replyText={onMaster ? replyText : null}
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
						<Key>WASD</Key> move · <Key>↑↓</Key> select · <Key>[ ]</Key> topic ·{" "}
						<Key>Tab</Key> next need · <Key>g</Key> master
					</Text>
				)}
				<Text color="gray">
					<Key>?</Key> shortcuts
				</Text>
			</Box>
			{overlay?.kind === "new" ? (
				<Centered rows={rows}>
					<NewSessionDialog
						repo={repo}
						onSubmit={createSession}
						onClose={() => setOverlay(null)}
					/>
				</Centered>
			) : null}
			{overlay?.kind === "import" ? (
				<Centered rows={rows}>
					<ImportDialog
						candidates={overlay.candidates}
						onSubmit={importSessions}
						onClose={() => setOverlay(null)}
					/>
				</Centered>
			) : null}
			{overlay?.kind === "confirm" && confirmSession ? (
				<Centered rows={rows}>
					<ConfirmDialog
						name={confirmSession.name}
						plan={overlay.plan}
						fromMaster={!!overlay.suggestionId}
						busy={overlay.busy}
						error={overlay.error}
					/>
				</Centered>
			) : null}
			{overlay?.kind === "replies" ? (
				<Centered rows={rows}>
					<RecentReplies
						replies={recentReplies()}
						pick={
							focusedSuggestion?.kind === "reply"
								? focusedSuggestion.text
								: null
						}
						selected={overlay.selected}
					/>
				</Centered>
			) : null}
			{overlay?.kind === "help" ? (
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

function Centered({ rows, children }: { rows: number; children: ReactNode }) {
	return (
		<Box
			position="absolute"
			width="100%"
			height={rows}
			alignItems="center"
			justifyContent="center"
		>
			{children}
		</Box>
	);
}

function Header({
	repo,
	needs,
	connected,
	masterError,
	zoom,
}: {
	repo: string;
	needs: number;
	connected: boolean;
	masterError: boolean;
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
				) : (
					<>
						{needs > 0 ? (
							<Text backgroundColor="yellow" color="black" bold>
								{` ${needs} need you `}
							</Text>
						) : null}
						{masterError ? (
							<Text backgroundColor="red" color="black" bold>
								{" master error "}
							</Text>
						) : null}
					</>
				)}
			</Text>
			<Text color="gray">zoom: {zoom}</Text>
		</Box>
	);
}

/** Session zoom (design screen 3): this pane is the left ⅓ beside the joined agent pane. */
function SessionZoom({
	session,
	sessions,
	suggestion,
	suggestions,
	columns,
	rows,
}: {
	session: Session;
	sessions: Session[];
	suggestion: Suggestion | undefined;
	suggestions: Suggestion[];
	columns: number;
	rows: number;
}) {
	const others = needsYou(sessions, suggestions).filter(
		(s) => s.id !== session.id,
	);
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
						<Text color="gray"> › {session.topic ?? "unsorted"} › </Text>
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
					suggestion={suggestion}
					others={others}
				/>
			</Box>
		</Box>
	);
}

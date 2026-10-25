import { basename } from "node:path";
import {
	type CleanupPlan,
	type CreateSessionParams,
	groupCategories,
	type ImportCandidate,
	type MasterState,
	needsYou,
	type Session,
	type Suggestion,
} from "@serenity/core";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { CanvasView, Key, MasterPanel, SessionMaster } from "./components";
import { openUrl } from "./open-url";
import {
	ConfirmDialog,
	ImportDialog,
	NewSessionDialog,
	RecentReplies,
	ShortcutsPanel,
} from "./overlays";
import { splitAtNewline } from "./text-input";
import { drawTopics, moveFocus } from "./topics";
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

export function App({ home, repo, tmuxPane }: AppProps) {
	const { exit } = useApp();
	const { columns, rows } = useWindowSize();
	const { state, connected, call } = useDaemon(home, repo);
	/** A session id, or `perm:<id>` for one of the master's permission requests. */
	const [focusId, setFocusId] = useState<string | null>(null);
	const [replyText, setReplyText] = useState<string | null>(null);
	/** The suggestion whose reply is being edited (e), if any. */
	const [replyEdit, setReplyEdit] = useState<string | null>(null);
	const [masterText, setMasterText] = useState<string | null>(null);
	const [sentReplies, setSentReplies] = useState<string[]>([]);
	const [overlay, setOverlay] = useState<Overlay>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const sessions = state?.sessions ?? [];
	const suggestions = state?.suggestions ?? [];
	const permissions = state?.permissions ?? [];
	const master: MasterState = state?.master ?? { status: "idle", error: null };
	const attached =
		sessions.find((s) => s.id === state?.attachedSessionId) ?? null;
	const groups = useMemo(() => groupCategories(sessions), [sessions]);
	const needs = useMemo(
		() => needsYou(sessions, suggestions),
		[sessions, suggestions],
	);

	const focusedPermission = focusId?.startsWith(PERM)
		? (permissions.find((p) => `${PERM}${p.id}` === focusId) ?? null)
		: null;
	const focused = sessions.find((s) => s.id === focusId) ?? null;
	const suggestionFor = (id: string | undefined): Suggestion | undefined =>
		suggestions.find((g) => g.sessionId === id);
	const focusedSuggestion = suggestionFor(focused?.id);

	const bodyHeight = rows - 2;
	const masterWidth = Math.max(34, Math.min(56, columns - 52));
	const topics = useMemo(
		() =>
			drawTopics({
				width: Math.max(1, columns - masterWidth),
				height: Math.max(1, bodyHeight),
				masterRow: Math.floor(bodyHeight / 2),
				groups,
				focusId: focused?.id ?? null,
				replyText,
			}),
		[columns, masterWidth, bodyHeight, groups, focused?.id, replyText],
	);

	// Keep focus on something that still exists.
	useEffect(() => {
		const valid = focusId?.startsWith(PERM)
			? !!focusedPermission
			: sessions.some((s) => s.id === focusId);
		if (!valid) setFocusId(topics.cards[0]?.sessionId ?? null);
	}, [topics, focusId, focusedPermission, sessions]);

	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(null), 4000);
		return () => clearTimeout(timer);
	}, [notice]);

	const fail = (e: unknown) =>
		setNotice(e instanceof Error ? e.message : String(e));

	/** Tab order: the master's permission requests, then NEEDS YOU. */
	const cycleNeeds = (back: boolean) => {
		const order = [
			...permissions.map((p) => `${PERM}${p.id}`),
			...needs.map((s) => s.id),
		];
		if (!order.length) return;
		const at = order.indexOf(focusId ?? "");
		const next =
			at === -1 ? 0 : (at + (back ? order.length - 1 : 1)) % order.length;
		setFocusId(order[next] ?? null);
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

	const sendReply = (text: string) => {
		const target = focused;
		setReplyText(null);
		setReplyEdit(null);
		setOverlay(null);
		if (!target || !text.trim()) return;
		setSentReplies((list) =>
			[text, ...list.filter((r) => r !== text)].slice(0, REPLY_HISTORY),
		);
		const sent = replyEdit
			? call("suggestion.accept", { id: replyEdit, text })
			: call("session.reply", { id: target.id, text });
		sent.catch(fail);
	};

	const recentReplies = (): string[] => {
		const pick =
			focusedSuggestion?.kind === "reply" ? focusedSuggestion.text : null;
		return [...new Set([pick, ...sentReplies].filter((r): r is string => !!r))];
	};

	useInput(
		(input, key) => {
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
				const edit = editText(replyText ?? "", input, key);
				if (edit) setReplyText(edit.value);
				return;
			}

			if (replyText !== null) {
				if (key.escape) {
					setReplyEdit(null);
					return setReplyText(null);
				}
				if (key.tab) {
					if (recentReplies().length)
						setOverlay({ kind: "replies", selected: 0 });
					return;
				}
				if (key.return) return sendReply(replyText);
				const edit = editText(replyText, input, key);
				if (!edit) return;
				if (edit.submit) return sendReply(edit.value);
				setReplyText(edit.value);
				return;
			}

			if (masterText !== null) {
				const send = (text: string) => {
					setMasterText(null);
					if (text.trim()) call("master.message", { repo, text }).catch(fail);
				};
				if (key.escape) return setMasterText(null);
				if (key.return) return send(masterText);
				const edit = editText(masterText, input, key);
				if (!edit) return;
				if (edit.submit) return send(edit.value);
				setMasterText(edit.value);
				return;
			}

			if (overlay?.kind === "help") {
				if (input === "?" || key.escape) setOverlay(null);
				return;
			}

			if (key.tab) return cycleNeeds(key.shift);
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
			if (move)
				return setFocusId(moveFocus(topics.cards, focused?.id ?? null, move));

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
					setReplyEdit(null);
					return setReplyText("");
			}
			if (key.return) {
				if (!tmuxPane)
					return setNotice("attach needs serenity to run inside tmux");
				call("session.attach", { id: focused.id, clientPane: tmuxPane }).catch(
					fail,
				);
			}
		},
		{ isActive: overlay?.kind !== "new" && overlay?.kind !== "import" },
	);

	const importSessions = async (claudeSessionIds: string[]) => {
		const adopted = await call("session.adopt", { repo, claudeSessionIds });
		setOverlay(null);
		if (adopted[0]) setFocusId(adopted[0].id);
		setNotice(
			`imported ${adopted.length} ${adopted.length === 1 ? "session" : "sessions"}`,
		);
	};

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
						calmCategories={calm}
						focusId={focusId}
						inputText={masterText}
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
						<Key>WASD</Key> move · <Key>Tab</Key> next need · <Key>g</Key>{" "}
						master
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
					suggestion={suggestion}
					others={others}
				/>
			</Box>
		</Box>
	);
}

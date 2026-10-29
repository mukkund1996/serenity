import { basename } from "node:path";
import {
	type CleanupPlan,
	type CreateSessionParams,
	completeMention,
	groupTopics,
	type ImportCandidate,
	isQueued,
	type MasterState,
	MENTION_LIST_MAX,
	masterQueue,
	matchMentions,
	mentionDraft,
	needsYou,
	type Ping,
	type Session,
	type Suggestion,
	type TopicGroup,
	topicOf,
	UNSORTED,
	type Usage,
} from "@serenity/core";
import {
	Box,
	type Key as InkKey,
	Text,
	useApp,
	useInput,
	useWindowSize,
} from "ink";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	Brand,
	CanvasView,
	Key,
	MASTER_INPUT,
	MasterPanel,
	REVIEW_ROW,
	SessionCounts,
	SessionMaster,
	SLACK_NEED,
} from "./components";
import { drawMap, type MasterItem, rowElements } from "./map";
import { inputRows, listWindow, PROMPT_W, stepSelection } from "./master-input";
import {
	needLines,
	planMaster,
	queueRows,
	suggestionLines,
} from "./master-layout";
import { openUrl } from "./open-url";
import {
	ArchivedList,
	archivedRows,
	ConfirmDialog,
	ImportDialog,
	KillDialog,
	NewSessionDialog,
	RecentReplies,
	RenameDialog,
	ShortcutsPanel,
} from "./overlays";
import { PULSE_PHASE_MS, pulseEnd, pulsing } from "./pulse";
import { QUEUE_ROW, QueueSection } from "./queue";
import { isNewlineKey, splitAtNewline } from "./text-input";
import { askLine } from "./theme";
import {
	type CardElement,
	cardElements,
	drawTopics,
	holdOrder,
	moveFocus,
	type NodeBox,
	SIDE_MIN_W,
	splitSides,
	stepTopic,
} from "./topics";
import { usageParts } from "./usage";
import { useDaemon } from "./use-daemon";

export const MIN_COLUMNS = 80;
export const MIN_ROWS = 24;
/** Marks a Slack suggestion's id in replyEdit: e edits its text, Enter sends it there. */
const SLACK_EDIT = "slack:";
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
	| { kind: "kill"; sessionId: string; busy: boolean; error: string | null }
	| { kind: "archived"; scroll: number }
	| { kind: "replies"; selected: number }
	| { kind: "import"; candidates: ImportCandidate[] }
	| { kind: "rename"; sessionId: string }
	| null;

/** The two zooms drawn here; the session zoom is an attached pane (design 1, 2, 3). */
type Zoom = "map" | "topics";

/** `/` search: what is typed, and the node focused before it, which Esc restores. */
interface Search {
	query: string;
	from: { node: string; element: string | null };
}

export interface AppProps {
	home: string;
	repo: string;
	/** This TUI's tmux pane, needed to attach a session beside it. */
	tmuxPane: string | undefined;
}

const PERM = "perm:";
/** A topic bubble's node id on the map, so no topic name clashes with MASTER. */
const TOPIC = "topic:";
/** The master panel's node id; every other node is a session card. */
const MASTER = "master";
/** Stable while the daemon has not answered, so the pulse clock stays idle. */
const NO_PINGS: Ping[] = [];

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
 * The clock the pulse reads (ADR 0039): it ticks once a blink while a ping's
 * pulse runs and stops when it ends, so an idle map never re-renders.
 */
function usePulseClock(pings: Ping[]): number {
	const [now, setNow] = useState(() => Date.now());
	const end = pulseEnd(pings);
	useEffect(() => {
		if (end === null || end <= Date.now()) return;
		setNow(Date.now());
		const timer = setInterval(() => {
			const t = Date.now();
			setNow(t);
			if (t >= end) clearInterval(timer);
		}, PULSE_PHASE_MS);
		return () => clearInterval(timer);
	}, [end]);
	return now;
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
	const set = useCallback((next: T) => {
		ref.current = next;
		setValue(next);
	}, []);
	return [value, set, ref];
}

export function App({ home, repo, tmuxPane }: AppProps) {
	const { exit } = useApp();
	const { columns, rows } = useWindowSize();
	const { state, connected, call } = useDaemon(home, repo, tmuxPane);
	/** The focused node: MASTER or a session card's id (arrow keys, WASD). */
	const [node, setNode] = useState<string>(MASTER);
	/** Whether Enter has gone into the master, so ↑↓ w s select inside it. */
	const [inside, setInside, insideRef] = useLiveState(false);
	/** The element selected inside the master, or a card's reply row; null means its first. */
	const [element, setElement] = useState<string | null>(null);
	const [replyText, setReplyText, replyRef] = useLiveState<string | null>(null);
	/** The suggestion whose reply is being edited (e), if any. */
	const [, setReplyEdit, replyEditRef] = useLiveState<string | null>(null);
	const [masterText, setMasterText, masterRef] = useLiveState<string | null>(
		null,
	);
	/** The selected row of the @ list over the master input. */
	const [mentionAt, setMentionAt, mentionRef] = useLiveState(0);
	/** The input text whose @ list Esc closed; the list returns once the text changes. */
	const [, setMentionOff, mentionOffRef] = useLiveState<string | null>(null);
	const [sentReplies, setSentReplies] = useState<string[]>([]);
	const [overlay, setOverlay] = useState<Overlay>(null);
	const [zoom, setZoom] = useState<Zoom>("topics");
	/** The message at the bottom of the master's conversation once scrolled back; null shows the latest (ADR 0041). */
	const [chatEnd, setChatEnd] = useState<number | null>(null);
	const [search, setSearch, searchRef] = useLiveState<Search | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	/** The queued reply Enter shows in full, if any (ADR 0040). */
	const [expanded, setExpanded] = useState<string | null>(null);

	const allSessions = state?.sessions ?? [];
	/** Archived sessions are off the map; `H` lists them. */
	const sessions = useMemo(
		() => allSessions.filter((s) => s.status !== "archived"),
		[allSessions],
	);
	const suggestions = state?.suggestions ?? [];
	const permissions = state?.permissions ?? [];
	const master: MasterState = state?.master ?? { status: "idle", error: null };
	const pings = state?.pings ?? NO_PINGS;
	const pulse = pulsing(pings, usePulseClock(pings));
	const attached =
		allSessions.find((s) => s.id === state?.attachedSessionId) ?? null;
	/** Each topic's card order as last drawn; the focused one keeps it. */
	const drawn = useRef(new Map<string, string[]>());
	const nodeSession = sessions.find((s) => s.id === node);
	const heldTopic =
		node === MASTER ? null : nodeSession ? topicOf(nodeSession) : UNSORTED;
	const groups = useMemo(() => {
		const next = holdOrder(groupTopics(sessions), drawn.current, heldTopic);
		drawn.current = new Map(
			next.map((g) => [g.name, g.sessions.map((s) => s.id)]),
		);
		return next;
	}, [sessions, heldTopic]);
	const needs = useMemo(
		() => needsYou(sessions, suggestions),
		[sessions, suggestions],
	);

	/** Replies the master's chat wants to send, waiting for y in its queue (ADR 0040). */
	const queue = useMemo(
		() => masterQueue(sessions, suggestions),
		[sessions, suggestions],
	);
	const queueId = (g: Suggestion) => `${QUEUE_ROW}${g.id}`;
	/** A card's suggestion, queued replies among them. */
	const suggestionFor = (id: string | undefined): Suggestion | undefined =>
		suggestions.find((g) => g.sessionId === id);
	/** A NEEDS YOU item's suggestion; its queued reply sits in the queue instead. */
	const needSuggestionFor = (id: string | undefined): Suggestion | undefined =>
		suggestions.find((g) => g.sessionId === id && !isQueued(g));
	const onMaster = node === MASTER;
	const bodyHeight = rows - 2;
	const masterWidth = Math.max(38, Math.min(72, columns - 50));
	const masterInner = masterWidth - 6;
	/** Names the @ list offers for the master input's text; none once Esc closed it. */
	const mentionOptions = (text: string | null): string[] => {
		if (text === null || text === mentionOffRef.current) return [];
		const draft = mentionDraft(text);
		return draft ? matchMentions(sessions, draft.query) : [];
	};
	const mentionNames = mentionOptions(masterText);
	const mentionList = mentionNames.length
		? listWindow(
				mentionNames,
				Math.min(mentionAt, mentionNames.length - 1),
				MENTION_LIST_MAX,
			)
		: null;

	const github = state?.github ?? { user: null, reviewRequests: [] };
	const slack = state?.slack ?? null;
	/** Slack's mentions and DMs that need the user; they close NEEDS YOU (ADR 0031). */
	const slackItems = slack?.items ?? [];
	const slackSuggestionFor = (itemId: string | undefined) =>
		slack?.suggestions.find((g) => g.itemId === itemId) ?? null;
	const conversation = state?.conversation ?? [];
	const chatEndAt = conversation.findIndex((m) => m.id === chatEnd);
	// Planned with the raw selection: only its place in NEEDS YOU matters here.
	const plan = planMaster({
		height: bodyHeight,
		inner: masterInner,
		empty: sessions.length === 0,
		needs: [
			...permissions.map((p) => ({
				id: `${PERM}${p.id}`,
				rows: 1 + needLines(p.detail, masterInner).length,
			})),
			...needs.map((s) => ({
				id: s.id,
				rows:
					1 +
					needLines(askLine(s), masterInner).length +
					suggestionLines(needSuggestionFor(s.id)?.label ?? "", masterInner)
						.length +
					(onMaster && element === s.id && replyText !== null ? 1 : 0),
			})),
			...slackItems.map((m) => ({
				id: `${SLACK_NEED}${m.id}`,
				// Its reply input takes the suggestion's row.
				rows:
					1 +
					needLines(m.action, masterInner).length +
					(slackSuggestionFor(m.id) ? 1 : 0),
			})),
		],
		queue: queue.map(({ suggestion }) => ({
			id: queueId(suggestion),
			rows: queueRows(
				suggestion.text ?? "",
				masterInner,
				onMaster && element === queueId(suggestion) && replyText !== null
					? "editing"
					: expanded === suggestion.id
						? "expanded"
						: "collapsed",
			),
		})),
		selected: onMaster && inside ? element : null,
		conversation,
		conversationEnd: chatEndAt === -1 ? undefined : chatEndAt + 1,
		slackError: !!slack?.error,
		reviews: github.reviewRequests,
		inputExtra:
			(masterText === null
				? 0
				: inputRows(masterText, masterInner - 2 - PROMPT_W).length - 1) +
			(mentionList?.names.length ?? 0),
	});
	/** The URL of a row selected in the master: the Slack item or a review request. */
	const linkOf = (id: string | null): string | null => {
		if (id?.startsWith(SLACK_NEED))
			return (
				slackItems.find((m) => `${SLACK_NEED}${m.id}` === id)?.permalink ?? null
			);
		if (id?.startsWith(REVIEW_ROW))
			return (
				plan.reviews.find((r) => `${REVIEW_ROW}${r.number}` === id)?.url ?? null
			);
		return null;
	};
	const card = onMaster ? null : (sessions.find((s) => s.id === node) ?? null);
	const cardSuggestion = suggestionFor(card?.id);

	/** What ↑↓ w s step through in the master: its requests, NEEDS YOU, Slack, review rows and input. A card only selects its reply row (i). */
	const elements: string[] = onMaster
		? [
				...permissions.map((p) => `${PERM}${p.id}`),
				...needs.map((s) => s.id),
				...slackItems.map((m) => `${SLACK_NEED}${m.id}`),
				...queue.map(({ suggestion }) => queueId(suggestion)),
				// The map's master box has no PR rows to select.
				...(zoom === "topics"
					? plan.reviews.map((r) => `${REVIEW_ROW}${r.number}`)
					: []),
				MASTER_INPUT,
			]
		: zoom === "map"
			? rowElements(!!cardSuggestion)
			: cardElements(!!cardSuggestion);
	// Outside the master nothing inside it is selected (ADR 0026).
	const selected =
		onMaster && !inside
			? null
			: element && elements.includes(element)
				? element
				: (elements[0] ?? null);
	const focusedPermission =
		onMaster && selected?.startsWith(PERM)
			? (permissions.find((p) => `${PERM}${p.id}` === selected) ?? null)
			: null;
	/** The session that y / e / n / i / o / f / x act on: the card, or the selected NEEDS YOU item. */
	const focused = onMaster
		? (sessions.find((s) => s.id === selected) ?? null)
		: card;
	const focusedSuggestion = onMaster
		? needSuggestionFor(focused?.id)
		: suggestionFor(focused?.id);
	/** The selected reply in the master's queue: y e n act on it, Enter shows it in full. */
	const queued =
		(onMaster && queue.find((q) => queueId(q.suggestion) === selected)) || null;
	/** The selected Slack item in NEEDS YOU: y e n act on its suggestion, Enter or o opens it, x dismisses it. */
	const slackItem =
		(onMaster && slackItems.find((m) => `${SLACK_NEED}${m.id}` === selected)) ||
		null;
	const slackSuggestion = slackSuggestionFor(slackItem?.id);
	const selectedLink = onMaster ? linkOf(selected) : null;

	/** Rows of the archived list shown at once: the screen less its frame, padding and hints. */
	const archivedHeight = Math.max(3, rows - 8);
	const archived = useMemo(() => archivedRows(allSessions), [allSessions]);
	/**
	 * The master panel sits in the centre of the topics zoom, topics on both
	 * sides, when each side fits a bubble; otherwise it docks left (ADR 0027).
	 * The map draws it itself.
	 */
	const panelWidth = zoom === "topics" ? masterWidth : 0;
	const leftWidth =
		zoom === "topics" && columns - masterWidth >= 2 * SIDE_MIN_W
			? Math.floor((columns - masterWidth) / 2)
			: 0;
	const masterRow = Math.floor(bodyHeight / 2);
	const calm = groups.filter((g) => g.attention === 0).length;
	/** The selected NEEDS YOU item, as the map's master box shows it. */
	const masterItem: MasterItem | null = !onMaster
		? null
		: queued
			? {
					kind: "queued",
					session: queued.session,
					text: queued.suggestion.text ?? "",
					replyText,
				}
			: focusedPermission
				? { kind: "permission", permission: focusedPermission }
				: slackItem
					? {
							kind: "slack",
							item: slackItem,
							suggestion: slackSuggestion,
							replyText,
							now: Date.now(),
						}
					: focused
						? {
								kind: "session",
								session: focused,
								suggestion: focusedSuggestion?.label ?? null,
								replyText,
							}
						: null;
	const layout = (() => {
		const focusElement = (onMaster ? "card" : selected) as CardElement;
		if (zoom === "map") {
			const map = drawMap({
				width: Math.max(1, columns),
				height: Math.max(1, bodyHeight),
				groups,
				focusId: card?.id ?? null,
				focusElement,
				focusSuggestion: cardSuggestion?.label ?? null,
				replyText: onMaster ? null : replyText,
				master: {
					focused: onMaster,
					thinking: master.status === "thinking",
					error: master.error,
					needCount: needs.length + permissions.length + slackItems.length,
					queueCount: queue.length,
					slackError: slack?.error ?? null,
					calmTopics: calm,
					empty: sessions.length === 0,
					item: masterItem,
					inputSelected: onMaster && selected === MASTER_INPUT,
					inputText: masterText,
					mentions: mentionList,
					lastMessage: conversation[conversation.length - 1] ?? null,
					pulse: pulse.master,
				},
				pulse: pulse.sessions,
			});
			const masterBox = { ...map.master, id: MASTER };
			return {
				canvas: map.canvas,
				left: null,
				nodes: [masterBox, ...map.rows.map((r) => ({ ...r, id: r.sessionId }))],
				// ← → a d move between topic bubbles here; ↑↓ w s walk the agents inside.
				moves: [
					masterBox,
					...map.bubbles.map((b) => ({ ...b, id: `${TOPIC}${b.id}` })),
				],
			};
		}
		const sides = leftWidth ? splitSides(groups) : { left: [], right: groups };
		const side = (width: number, list: TopicGroup[], at: "left" | "right") =>
			drawTopics({
				width: Math.max(1, width),
				height: Math.max(1, bodyHeight),
				masterRow,
				groups: list,
				focusId: card?.id ?? null,
				focusElement,
				focusSuggestion: cardSuggestion?.label ?? null,
				replyText: onMaster ? null : replyText,
				side: at,
				pulse: pulse.sessions,
			});
		const right = side(columns - leftWidth - panelWidth, sides.right, "right");
		const left = leftWidth ? side(leftWidth, sides.left, "left") : null;
		// Nodes in screen columns: left canvas, master, right canvas.
		const rightX = leftWidth + panelWidth;
		const nodes = [
			{ id: MASTER, x: leftWidth, y: 0, w: panelWidth, h: bodyHeight },
			...(left?.cards ?? []).map((c) => ({ ...c, id: c.sessionId })),
			...right.cards.map((c) => ({ ...c, x: c.x + rightX, id: c.sessionId })),
		];
		return {
			canvas: right.canvas,
			left: left?.canvas ?? null,
			nodes,
			moves: nodes,
		};
	})();
	/** The focusable nodes on screen, in canvas cells. */
	const nodes: NodeBox[] = layout.nodes;
	const nodeIds = nodes.map((n) => n.id).join(" ");

	/** Focuses a node; `enter` also goes into the master, as Enter does. */
	const focusNode = (id: string, at: string | null = null, enter = false) => {
		setNode(id);
		setElement(at);
		setInside(enter);
	};
	/** The agent last focused in each topic, where moves land on the map. */
	const lastInTopic = useRef(new Map<string, string>());
	const cardTopic = card ? topicOf(card) : null;
	if (card && cardTopic) lastInTopic.current.set(cardTopic, card.id);
	/** Moves on the map: to the next bubble's last-focused agent, or its first. */
	const moveToTopic = (dir: "up" | "down" | "left" | "right") => {
		const from = cardTopic === null ? MASTER : `${TOPIC}${cardTopic}`;
		const to = moveFocus(layout.moves, from, dir);
		const group = groups.find((g) => `${TOPIC}${g.name}` === to);
		if (!group) return focusNode(MASTER);
		if (group.name === cardTopic) return;
		const last = lastInTopic.current.get(group.name);
		const id = group.sessions.some((s) => s.id === last)
			? (last as string)
			: group.sessions[0]?.id;
		if (id) focusNode(id);
	};
	/**
	 * ↑↓ w s on an agent on the map: to the next or previous agent in its
	 * bubble, and past either end on to the bubble above or below.
	 */
	const stepInTopic = (up: boolean) => {
		const list = groups.find((g) => g.name === cardTopic)?.sessions ?? [];
		const i = list.findIndex((s) => s.id === card?.id);
		const to = list[i + (up ? -1 : 1)];
		if (to) return focusNode(to.id);
		moveToTopic(up ? "up" : "down");
	};
	/** A session just created or imported, focused before the daemon reports it. */
	const arriving = useRef<string | null>(null);

	// Keep focus on a card that is still on the map; otherwise the master has it.
	useEffect(() => {
		if (nodeIds.split(" ").includes(node)) return;
		// All sessions: one archived as soon as it arrived has still arrived.
		if (node === arriving.current && !allSessions.some((s) => s.id === node))
			return;
		arriving.current = null;
		setNode(MASTER);
		setElement(null);
		setInside(false);
	}, [nodeIds, node, allSessions, setInside]);

	// Leaving the master, the topics zoom or the input shows the latest messages again.
	const chatOpen = onMaster && zoom === "topics";
	const inputOpen = masterText !== null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: a change of either is the trigger
	useEffect(() => setChatEnd(null), [chatOpen, inputOpen]);

	/** PgUp PgDn (Shift+↑↓) step the master's conversation a message back or forward. */
	const scrollChat = (back: boolean) => {
		const { start, end, newer } = plan.conversation;
		if (back) {
			if (start > 0) setChatEnd(conversation[end - 2]?.id ?? null);
			return;
		}
		if (!newer) return;
		setChatEnd(newer === 1 ? null : (conversation[end]?.id ?? null));
	};

	useEffect(() => {
		if (!notice) return;
		const timer = setTimeout(() => setNotice(null), 4000);
		return () => clearTimeout(timer);
	}, [notice]);

	const fail = (e: unknown) =>
		setNotice(e instanceof Error ? e.message : String(e));

	/** Tab order: the master's permission requests, then NEEDS YOU, Slack, the queue last. Focuses the master. */
	const cycleNeeds = (back: boolean) => {
		const order = [
			...permissions.map((p) => `${PERM}${p.id}`),
			...needs.map((s) => s.id),
			...slackItems.map((m) => `${SLACK_NEED}${m.id}`),
			...queue.map(({ suggestion }) => queueId(suggestion)),
		];
		if (!order.length) return;
		const at = onMaster ? order.indexOf(selected ?? "") : -1;
		const next =
			at === -1 ? 0 : (at + (back ? order.length - 1 : 1)) % order.length;
		focusNode(MASTER, order[next] ?? null, true);
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

	/** Enter on a card attaches it; inside the master it acts on the selected element. */
	const activate = () => {
		if (!onMaster) return card ? attach(card) : undefined;
		if (selected === MASTER_INPUT) return setMasterText("");
		if (selectedLink) return openUrl(selectedLink);
		if (focused) attach(focused);
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
		const editing = replyEditRef.current;
		endReply();
		setOverlay(null);
		if (editing?.startsWith(SLACK_EDIT)) {
			if (text.trim()) acceptSlack(editing.slice(SLACK_EDIT.length), text);
			return;
		}
		if (!text.trim()) return;
		// A queued reply being edited (e) has no session selected; its suggestion says where it goes.
		const sent = editing
			? call("suggestion.accept", { id: editing, text })
			: target
				? call("session.reply", { id: target.id, text })
				: null;
		if (!sent) return;
		setSentReplies((list) =>
			[text, ...list.filter((r) => r !== text)].slice(0, REPLY_HISTORY),
		);
		sent.catch(fail);
	};

	/** y on a Slack suggestion: post the reply, or type the question to its session. */
	const acceptSlack = (itemId: string, text?: string) => {
		const ask = slackSuggestionFor(itemId)?.kind === "ask";
		call("slack.accept", { repo, itemId, ...(text ? { text } : {}) }).then(
			() =>
				setNotice(ask ? "asked; its answer becomes a reply" : "sent to Slack"),
			fail,
		);
	};

	/** Sessions matching a search, in the order the map draws them. */
	const matches = (query: string): Session[] => {
		const q = query.trim().toLowerCase();
		if (!q) return [];
		return groups
			.flatMap((g) => g.sessions)
			.filter((s) =>
				[s.name, topicOf(s), s.branch ?? ""].some((field) =>
					field.toLowerCase().includes(q),
				),
			);
	};
	const searchHits = search ? matches(search.query) : [];

	/** Types into the search and focuses the first hit as it narrows. */
	const typeSearch = (current: Search, query: string) => {
		setSearch({ ...current, query });
		const first = matches(query)[0];
		if (first) focusNode(first.id);
	};

	const recentReplies = (): string[] => {
		const pick =
			focusedSuggestion?.kind === "reply" ? focusedSuggestion.text : null;
		return [...new Set([pick, ...sentReplies].filter((r): r is string => !!r))];
	};

	useInput(
		function onKey(input: string, key: InkKey) {
			// Ctrl+m focuses the master from every view, the session zoom too.
			// tmux passes it here as an extended key; Enter stays Enter (ADR 0026).
			const toMasterKey = key.ctrl && input === "m";
			if (attached) {
				if (key.escape || (key.ctrl && input === "g") || toMasterKey)
					call("session.detach", { id: attached.id }).catch(fail);
				if (toMasterKey) focusNode(MASTER);
				return;
			}

			const busy =
				(overlay?.kind === "confirm" || overlay?.kind === "kill") &&
				overlay.busy;
			if (toMasterKey && !busy) {
				setOverlay(null);
				setSearch(null);
				setMasterText(null);
				setReplyText(null);
				setReplyEdit(null);
				return focusNode(MASTER);
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

			if (overlay?.kind === "kill") {
				if (overlay.busy) return;
				if (input === "n" || key.escape) return setOverlay(null);
				if (input !== "y") return;
				setOverlay({ ...overlay, busy: true, error: null });
				call("session.kill", { id: overlay.sessionId }).then(
					() => setOverlay(null),
					(e: Error) =>
						setOverlay({ ...overlay, busy: false, error: e.message }),
				);
				return;
			}

			if (overlay?.kind === "archived") {
				if (input === "H" || key.escape) return setOverlay(null);
				const last = Math.max(0, archived.length - archivedHeight);
				if (key.upArrow || input === "w")
					setOverlay({ ...overlay, scroll: Math.max(0, overlay.scroll - 1) });
				if (key.downArrow || input === "s")
					setOverlay({
						...overlay,
						scroll: Math.min(last, overlay.scroll + 1),
					});
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

			const scroll =
				key.pageUp || (key.shift && key.upArrow)
					? "back"
					: key.pageDown || (key.shift && key.downArrow)
						? "forward"
						: null;
			if (scroll && chatOpen && !overlay && !searchRef.current)
				return scrollChat(scroll === "back");

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
				// Sending keeps the input open, cleared, for the next message.
				const send = (text: string) => {
					setChatEnd(null);
					setMasterText("");
					setMentionAt(0);
					setMentionOff(null);
					if (text.trim()) call("master.message", { repo, text }).catch(fail);
				};
				const options = mentionOptions(toMaster);
				// Esc closes the @ list first; with no list it closes the input.
				if (key.escape) {
					if (options.length) return setMentionOff(toMaster);
					setMentionOff(null);
					return setMasterText(null);
				}
				// Shift+Enter, Alt+Enter and Ctrl+J start a new line; Enter sends.
				if (isNewlineKey(input, key)) return setMasterText(`${toMaster}\n`);
				if (options.length) {
					const at = Math.min(mentionRef.current, options.length - 1);
					if (key.upArrow || key.downArrow)
						return setMentionAt(
							stepSelection(at, options.length, key.upArrow ? -1 : 1),
						);
					// Tab, and Enter while the list is open, complete the name.
					if (key.tab || key.return) {
						setMasterText(completeMention(toMaster, options[at] as string));
						setMentionAt(0);
						return;
					}
				}
				if (key.tab) return;
				if (key.return) return send(toMaster);
				const edit = editText(toMaster, input, key);
				if (!edit) return;
				if (edit.submit) return send(edit.value);
				setMasterText(edit.value);
				setMentionAt(0);
				return;
			}

			const finding = searchRef.current;
			if (finding !== null) {
				if (key.escape) {
					setSearch(null);
					return focusNode(finding.from.node, finding.from.element);
				}
				if (key.return) return setSearch(null);
				if (key.tab || key.upArrow || key.downArrow) {
					const hits = matches(finding.query);
					if (!hits.length) return;
					const at = hits.findIndex((h) => h.id === node);
					const back = key.upArrow || (key.tab && key.shift);
					const next = (at + (back ? hits.length - 1 : 1)) % hits.length;
					return focusNode((hits[next] ?? (hits[0] as Session)).id);
				}
				const edit = editText(finding.query, input, key);
				if (!edit) return;
				typeSearch(finding, edit.value);
				if (edit.submit) setSearch(null);
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
			// Esc leaves the master; elsewhere it goes up a level: topics › map.
			if (key.escape) {
				if (onMaster && insideRef.current) return focusNode(MASTER);
				if (zoom === "topics") setZoom("map");
				return;
			}
			const move =
				key.upArrow || input === "w"
					? "up"
					: key.downArrow || input === "s"
						? "down"
						: key.leftArrow || input === "a"
							? "left"
							: key.rightArrow || input === "d"
								? "right"
								: null;
			// Inside the master ↑↓ w s select its elements; ← → a d leave it.
			if ((move === "up" || move === "down") && onMaster && insideRef.current) {
				const at = selected ? elements.indexOf(selected) : 0;
				const next = Math.max(
					0,
					Math.min(elements.length - 1, at + (move === "up" ? -1 : 1)),
				);
				return setElement(elements[next] ?? null);
			}
			if (move) {
				if (zoom === "map" && card && (move === "up" || move === "down"))
					return stepInTopic(move === "up");
				if (zoom === "map") return moveToTopic(move);
				return focusNode(moveFocus(nodes, node, move) ?? MASTER);
			}
			// Enter goes into the master; on a card it attaches (activate).
			if (key.return && onMaster && !insideRef.current) return setInside(true);
			if (input === "[" || input === "]") {
				const id = stepTopic(groups, card?.id ?? null, input === "]" ? 1 : -1);
				if (id) focusNode(id);
				return;
			}

			// x dismisses a Slack item for good (ADR 0034).
			if (slackItem && input === "x")
				return void call("slack.dismiss", {
					channelId: slackItem.channelId,
					ts: slackItem.ts,
				}).then(
					() => setNotice(`dismissed ${slackItem.author}'s message`),
					fail,
				);
			// y e n on a Slack item act on its suggestion (ADR 0024).
			if (slackItem && ["y", "e", "n"].includes(input)) {
				if (slackSuggestion?.status !== "pending") return;
				if (input === "y") return acceptSlack(slackItem.id);
				if (input === "n")
					return void call("slack.decline", {
						repo,
						itemId: slackItem.id,
					}).catch(fail);
				setReplyEdit(`${SLACK_EDIT}${slackItem.id}`);
				setReplyText(slackSuggestion.text);
				return;
			}

			// y sends a queued reply, e edits it, n or x drops it, Enter shows it in full (ADR 0040).
			if (queued) {
				const { suggestion } = queued;
				if (key.return)
					return setExpanded(expanded === suggestion.id ? null : suggestion.id);
				if (input === "y") return void accept(suggestion, queued.session);
				if (input === "n" || input === "x")
					return void call("suggestion.decline", { id: suggestion.id }).catch(
						fail,
					);
				if (input === "e") {
					setReplyEdit(suggestion.id);
					setReplyText(suggestion.text ?? "");
					return;
				}
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
				// z zooms out to the map; Z zooms in to topics, and from a
				// card in topics on into its session.
				case "z":
					return setZoom("map");
				case "Z":
					if (zoom === "topics" && card) return attach(card);
					return setZoom("topics");
				case "c":
					return focusNode(MASTER);
				case "/":
					return setSearch({ query: "", from: { node, element } });
				case "i":
					// On the master i opens its input, unless a session in NEEDS YOU is selected: then it replies to that one.
					if (onMaster && !focused) {
						setMentionOff(null);
						return setMasterText("");
					}
					break;
				case "N":
					return setOverlay({ kind: "new" });
				case "H":
					return setOverlay({ kind: "archived", scroll: 0 });
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
			if (input === "o" && selectedLink) return openUrl(selectedLink);
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
				case "p":
					call("session.pin", {
						id: focused.id,
						pinned: !focused.pinned,
					}).then(
						() =>
							setNotice(
								focused.pinned
									? `unpinned ${focused.name}`
									: `pinned ${focused.name}; it stays for reuse`,
							),
						fail,
					);
					return;
				case "x":
					void openConfirm(focused, null);
					return;
				case "K":
					return setOverlay({
						kind: "kill",
						sessionId: focused.id,
						busy: false,
						error: null,
					});
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
				case "r":
					return setOverlay({ kind: "rename", sessionId: focused.id });
			}
		},
		{
			isActive:
				overlay?.kind !== "new" &&
				overlay?.kind !== "import" &&
				overlay?.kind !== "rename",
		},
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

	const renameSession = async (id: string, name: string) => {
		await call("session.rename", { id, name });
		setOverlay(null);
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

	const confirmSession =
		overlay?.kind === "confirm" ||
		overlay?.kind === "kill" ||
		overlay?.kind === "rename"
			? allSessions.find((s) => s.id === overlay.sessionId)
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
				sessions={sessions}
				zoom={zoom}
				usage={state?.usage ?? null}
				averageWaitMs={state?.averageWaitMs ?? null}
			/>
			<Box height={bodyHeight}>
				{layout.left ? <CanvasView canvas={layout.left} /> : null}
				{zoom === "topics" ? (
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
							suggestions={suggestions.filter((g) => !isQueued(g))}
							permissions={permissions}
							conversation={conversation}
							master={master}
							calmTopics={calm}
							plan={plan}
							slack={slack}
							focused={onMaster}
							selected={onMaster ? selected : null}
							inputText={masterText}
							mentions={mentionList}
							replyText={onMaster ? replyText : null}
							queue={
								<QueueSection
									queue={queue}
									window={plan.queue}
									selected={onMaster ? selected : null}
									expanded={expanded}
									replyText={onMaster ? replyText : null}
									inner={masterInner}
								/>
							}
							pulse={pulse.master}
						/>
					</Box>
				) : null}
				<CanvasView canvas={layout.canvas} />
			</Box>
			<Box width="100%" justifyContent="space-between" paddingX={2}>
				{search ? (
					<Text wrap="truncate">
						<Text color="magenta">/ </Text>
						<Text color="whiteBright">{search.query}█</Text>
						<Text color="gray">
							{"  "}
							{!search.query.trim()
								? "name, topic or branch"
								: searchHits.length
									? `${Math.max(1, searchHits.findIndex((h) => h.id === node) + 1)} of ${searchHits.length} · Tab next · Enter go · Esc back`
									: "no match · Esc back"}
						</Text>
					</Text>
				) : notice ? (
					<Text color="red" wrap="truncate">
						{notice}
					</Text>
				) : (
					<Text color="gray" wrap="truncate">
						<Key>←↑↓→ WASD</Key> move · <Key>Enter</Key> open · <Key>i</Key>{" "}
						message · <Key>Ctrl+m</Key> master · <Key>z Z</Key> zoom ·{" "}
						<Key>/</Key> search
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
			{overlay?.kind === "rename" && confirmSession ? (
				<Centered rows={rows}>
					<RenameDialog
						session={confirmSession}
						onSubmit={(name) => renameSession(confirmSession.id, name)}
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
			{overlay?.kind === "kill" && confirmSession ? (
				<Centered rows={rows}>
					<KillDialog
						session={confirmSession}
						busy={overlay.busy}
						error={overlay.error}
					/>
				</Centered>
			) : null}
			{overlay?.kind === "archived" ? (
				<Centered rows={rows}>
					<ArchivedList
						rows={archived}
						scroll={overlay.scroll}
						height={archivedHeight}
						width={Math.min(80, columns - 4)}
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
	sessions,
	zoom,
	usage,
	averageWaitMs,
}: {
	repo: string;
	needs: number;
	connected: boolean;
	masterError: boolean;
	sessions: Session[];
	zoom: string;
	usage: Usage | null;
	averageWaitMs: number | null;
}) {
	const parts = usageParts(usage, averageWaitMs, Date.now());
	return (
		<Box width="100%" backgroundColor="black" paddingX={1}>
			<Box flexShrink={1} overflow="hidden">
				<Text wrap="truncate">
					<Brand />
					<Text color="gray"> {basename(repo)}</Text>
				</Text>
			</Box>
			{/* The usage bar stays whole; the repo name gives way first (ADR 0020). */}
			<Box flexShrink={0} marginLeft={2}>
				<Text>
					{parts.map((part, i) => (
						<Text key={part.label}>
							{i > 0 ? <Text color="gray"> · </Text> : null}
							<Text color="gray">{part.label} </Text>
							<Text color={part.color}>{part.value}</Text>
						</Text>
					))}
				</Text>
			</Box>
			<Box flexGrow={1} flexShrink={0} justifyContent="center">
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
			</Box>
			{/* Counts give way before the usage bar and the zoom (ADR 0021). */}
			{sessions.length ? (
				<Box flexShrink={1} overflow="hidden" marginX={2}>
					<SessionCounts sessions={sessions} />
				</Box>
			) : null}
			<Box flexShrink={0}>
				<Text color="gray">zoom: {zoom}</Text>
			</Box>
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
						<Brand />
						<Text color="gray"> › {topicOf(session)} › </Text>
						<Text>{session.name}</Text>
					</Text>
				</Box>
				<Box flexShrink={0} marginLeft={1}>
					<Text color="gray">
						<Key>Ctrl+g</Key> map · <Key>Ctrl+m</Key> master
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

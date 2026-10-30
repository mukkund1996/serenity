import {
	archivedTopics,
	type CleanupPlan,
	type CreateSessionParams,
	type ImportCandidate,
	type Session,
	type SessionMode,
} from "@serenity/core";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { Key, TitledBox } from "./components";
import {
	CURSOR,
	editField,
	type Field,
	fieldAt,
	fieldWindow,
} from "./text-input";
import { cardText, glyph } from "./theme";

const DIALOG_W = 64;
const FIELDS = ["name", "prompt", "cwd", "branch", "mode"] as const;
type FieldName = (typeof FIELDS)[number];
type TextFieldName = Exclude<FieldName, "mode">;
/** A dialog's text field: its width, less the frame, padding and the label's 13 columns. */
const FIELD_W = DIALOG_W - 2 - 4 - 13;

/** A dialog's text field, the cursor's cell inverted while it has focus (ADR 0042). */
function DialogField({
	field,
	focused,
	placeholder = "",
}: {
	field: Field;
	focused: boolean;
	placeholder?: string;
}) {
	if (!field.text)
		return (
			<Text wrap="truncate">
				<Text color={focused ? "black" : "gray"}>{placeholder}</Text>
				{focused ? <Text color="whiteBright">{CURSOR}</Text> : null}
			</Text>
		);
	if (!focused)
		return (
			<Text color="whiteBright" wrap="truncate-start">
				{field.text}
			</Text>
		);
	const { before, at, after } = fieldWindow(field, FIELD_W);
	return (
		<Text color="whiteBright" wrap="truncate">
			{before}
			{at === null ? CURSOR : <Text inverse>{at}</Text>}
			{after}
		</Text>
	);
}

/**
 * New session dialog (design 4d): name, an optional first prompt, working
 * dir, new worktree or existing branch.
 */
export function NewSessionDialog({
	repo,
	onSubmit,
	onClose,
}: {
	repo: string;
	onSubmit: (params: CreateSessionParams) => Promise<void>;
	onClose: () => void;
}) {
	const [values, setValues] = useState<Record<TextFieldName, Field>>({
		name: fieldAt(""),
		prompt: fieldAt(""),
		cwd: fieldAt(repo),
		branch: fieldAt(""),
	});
	const [mode, setMode] = useState<SessionMode>("worktree");
	const [field, setField] = useState<FieldName>("name");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useInput(
		(input, key) => {
			if (key.escape) return onClose();
			if (key.tab) {
				const step = key.shift ? FIELDS.length - 1 : 1;
				setField(
					FIELDS[(FIELDS.indexOf(field) + step) % FIELDS.length] as FieldName,
				);
				return;
			}
			const submit = (v: typeof values) => {
				if (!v.name.text.trim()) return setError("Give the session a name.");
				setBusy(true);
				setError(null);
				onSubmit({
					repo,
					name: v.name.text.trim().replace(/\s+/g, "-"),
					cwd: v.cwd.text,
					mode,
					branch: v.branch.text || undefined,
					prompt: v.prompt.text.trim() || undefined,
				}).catch((e: Error) => {
					setBusy(false);
					setError(e.message);
				});
			};
			if (key.return) return submit(values);
			if (field === "mode") {
				if (input === " " || key.leftArrow || key.rightArrow)
					setMode(mode === "worktree" ? "branch" : "worktree");
				return;
			}
			const edit = editField(values[field], input, key);
			if (edit) {
				const next = { ...values, [field]: edit.field };
				setValues(next);
				if (edit.submit) return submit(next);
			}
			setError(null);
		},
		{ isActive: !busy },
	);

	const row = (label: string, f: TextFieldName, placeholder = "") => (
		<Box marginTop={1}>
			<Box width={13} flexShrink={0}>
				<Text color="white">{label}</Text>
			</Box>
			<Box backgroundColor={field === f ? "gray" : undefined} flexGrow={1}>
				<DialogField
					field={values[f]}
					focused={field === f}
					placeholder={placeholder}
				/>
			</Box>
		</Box>
	);

	return (
		<TitledBox
			title="New session"
			titleColor="whiteBright"
			fill="black"
			borderStyle="double"
			borderColor="white"
			width={DIALOG_W}
			right={<Text color="white"> Esc close </Text>}
		>
			{row("Name", "name")}
			{row("First prompt", "prompt", "optional")}
			{row("Working dir", "cwd")}
			{row("Branch", "branch", "same as name")}
			<Box marginTop={1}>
				<Box width={13}>
					<Text color="gray"> </Text>
				</Box>
				<Text inverse={field === "mode"}>
					{mode === "worktree" ? "(•)" : "( )"} new worktree{" "}
					{mode === "branch" ? "(•)" : "( )"} existing branch
				</Text>
			</Box>
			<Box marginTop={1} justifyContent="space-between">
				<Text color="red">{error ?? (busy ? " " : "")}</Text>
				<Text color="white">
					{busy ? (
						"creating…"
					) : (
						<>
							<Key>Enter</Key> create <Key>Tab</Key> next field
						</>
					)}
				</Text>
			</Box>
		</TitledBox>
	);
}

/**
 * Kept to a fixed handful of rows: related keys share one, so a new key
 * joins a row rather than growing the panel. The footer covers the moves,
 * Enter, i, Ctrl+m, z Z and /.
 */
const SHORTCUTS: Array<[string, Array<[string, string]>]> = [
	[
		"ON A NODE",
		[
			["Enter i", "attach · message · chat"],
			["Enter Esc", "into the master, mark ▸ seen · leave"],
			["o f p", "open PR · watch · pin"],
			["r K x", "rename · kill agent · clean up"],
		],
	],
	[
		"MAP",
		[
			["[ ] Ctrl+m", "topic · master"],
			["N I", "new session · import"],
			["Tab Esc H", "next need · zoom out · archived"],
			["y e n x", "run ◆ · edit · decline · dismiss"],
			["PgUp PgDn", "master chat back · on (Shift+↑↓)"],
		],
	],
];

/** Shortcuts panel (design 4e); `?` toggles it. Lists only what this build supports. */
export function ShortcutsPanel() {
	return (
		<TitledBox
			title="Shortcuts"
			titleColor="whiteBright"
			fill="black"
			borderStyle="single"
			borderColor="white"
			width={51}
			right={
				<Text color="white">
					{" "}
					<Key>?</Key> hide{" "}
				</Text>
			}
		>
			{SHORTCUTS.map(([section, keys]) => (
				<Box key={section} flexDirection="column" marginTop={1}>
					<Text color="whiteBright" bold>
						{section}
					</Text>
					{keys.map(([k, label]) => (
						<Box key={k}>
							<Box width={11}>
								<Key>{k}</Key>
							</Box>
							<Text>{label}</Text>
						</Box>
					))}
				</Box>
			))}
			<Box flexDirection="column" marginTop={1}>
				<Text color="whiteBright" bold>
					STATUS
				</Text>
				<Text>
					<Text color="yellow">◐</Text> waiting <Text color="blue">●</Text> in
					progress <Text color="green">✓</Text> finished
				</Text>
				<Text color="white">
					name in grey = idle · ↗ imported (U: full tracking)
				</Text>
			</Box>
			<Box marginTop={1}>
				<Text color="white">
					<Key>q</Key> quits the map · sessions keep running
				</Text>
			</Box>
		</TitledBox>
	);
}

/**
 * Rename a session (r). Starts from the current name, edited like any text
 * field (ADR 0042): Ctrl+u clears what is before the cursor.
 * Topics have no rename: the master manages them (ADR 0012).
 */
export function RenameDialog({
	session,
	onSubmit,
	onClose,
}: {
	session: Session;
	onSubmit: (name: string) => Promise<void>;
	onClose: () => void;
}) {
	const [name, setName] = useState(() => fieldAt(session.name));
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useInput(
		(input, key) => {
			if (key.escape) return onClose();
			const submit = (value: string) => {
				const next = value.trim().replace(/\s+/g, "-");
				if (!next) return setError("Give the session a name.");
				if (next === session.name) return onClose();
				setBusy(true);
				setError(null);
				onSubmit(next).catch((e: Error) => {
					setBusy(false);
					setError(e.message);
				});
			};
			if (key.return) return submit(name.text);
			setError(null);
			const edit = editField(name, input, key);
			if (!edit) return;
			setName(edit.field);
			if (edit.submit) submit(edit.field.text);
		},
		{ isActive: !busy },
	);

	return (
		<TitledBox
			title={`Rename ${session.name}`}
			titleColor="whiteBright"
			fill="black"
			borderStyle="double"
			borderColor="white"
			width={DIALOG_W}
			right={<Text color="white"> Esc close </Text>}
		>
			<Box marginTop={1}>
				<Box width={13} flexShrink={0}>
					<Text color="white">Name</Text>
				</Box>
				<Box backgroundColor="gray" flexGrow={1}>
					<DialogField field={name} focused />
				</Box>
			</Box>
			{session.origin === "spawned" ? null : (
				<Text color="white" wrap="truncate">
					its tmux window keeps its name: it is yours
				</Text>
			)}
			<Box marginTop={1} justifyContent="space-between">
				<Text color="red" wrap="truncate">
					{error ?? ""}
				</Text>
				<Text color="white">
					{busy ? (
						"renaming…"
					) : (
						<>
							<Key>Enter</Key> rename <Key>Ctrl+u</Key> clear
						</>
					)}
				</Text>
			</Box>
		</TitledBox>
	);
}

/** Confirm a cleanup (design 4b): every step, then the safety facts from git. */
export function ConfirmDialog({
	name,
	plan,
	fromMaster,
	busy,
	error,
}: {
	name: string;
	plan: CleanupPlan;
	fromMaster: boolean;
	busy: boolean;
	error: string | null;
}) {
	return (
		<TitledBox
			title={`Clean up ${name}?`}
			titleColor="whiteBright"
			borderStyle="double"
			borderColor="white"
			width={DIALOG_W}
			fill="black"
		>
			{fromMaster ? <Text color="magenta">◆ requested by master</Text> : null}
			<Box marginTop={1}>
				<Text color="white">This will:</Text>
			</Box>
			{plan.steps.map((step) => {
				const keep = step.startsWith("keep");
				return (
					<Text key={step} wrap="truncate">
						<Text color={keep ? "white" : "red"}>{keep ? "–" : "✕"} </Text>
						<Text color={keep ? "white" : undefined}>{step}</Text>
					</Text>
				);
			})}
			{plan.safety.length ? (
				<Box marginTop={1}>
					<Text color={plan.safe ? "green" : "yellow"} wrap="truncate">
						{plan.safety.join(" · ")}
					</Text>
				</Box>
			) : null}
			<Box marginTop={1} justifyContent="space-between">
				<Text color="red" wrap="truncate">
					{error ?? ""}
				</Text>
				<Text color="white">
					{busy ? (
						"cleaning up…"
					) : (
						<>
							<Key>y</Key> approve <Key>n</Key> cancel
						</>
					)}
				</Text>
			</Box>
		</TitledBox>
	);
}

/** Confirm a kill (K): the agent stops, its worktree and branch stay. */
export function KillDialog({
	session,
	busy,
	error,
}: {
	session: Session;
	busy: boolean;
	error: string | null;
}) {
	return (
		<TitledBox
			title={`Kill ${session.name}?`}
			titleColor="whiteBright"
			borderStyle="double"
			borderColor="white"
			width={DIALOG_W}
			fill="black"
		>
			<Box marginTop={1}>
				<Text color="white">This will:</Text>
			</Box>
			<Text wrap="truncate">
				<Text color="red">✕ </Text>
				{session.tracking === "observed"
					? `stop claude in ${session.name} · its tmux window stays`
					: `stop the session ${session.name}`}
			</Text>
			<Text color="white" wrap="truncate">
				– archive it · H lists it
			</Text>
			{session.worktree || session.branch ? (
				<Text color="white" wrap="truncate">
					– keep {session.worktree ? "its worktree and branch" : "its branch"} ·{" "}
					<Key>x</Key> cleans those up
				</Text>
			) : null}
			<Box marginTop={1} justifyContent="space-between">
				<Text color="red" wrap="truncate">
					{error ?? ""}
				</Text>
				<Text color="white">
					{busy ? (
						"stopping…"
					) : (
						<>
							<Key>y</Key> kill <Key>n</Key> cancel
						</>
					)}
				</Text>
			</Box>
		</TitledBox>
	);
}

/** One row of the archived list: a topic, or a session under it. */
type ArchivedRow = { topic: string } | { session: Session };

export function archivedRows(sessions: Session[]): ArchivedRow[] {
	return archivedTopics(sessions).flatMap((group) => [
		{ topic: group.name },
		...group.sessions.map((session) => ({ session })),
	]);
}

/** Archived sessions (H), nested under their topic; ↑↓ scroll. */
export function ArchivedList({
	rows,
	scroll,
	height,
	width,
}: {
	rows: ArchivedRow[];
	scroll: number;
	/** Rows of the list shown at once. */
	height: number;
	width: number;
}) {
	const shown = rows.slice(scroll, scroll + height);
	const below = rows.length - scroll - shown.length;
	return (
		<TitledBox
			title="Archived"
			titleColor="whiteBright"
			borderStyle="single"
			borderColor="white"
			width={width}
			fill="black"
			right={<Text color="white"> ↑↓ H Esc </Text>}
		>
			{rows.length === 0 ? (
				<Box marginTop={1}>
					<Text color="white">Nothing archived yet.</Text>
				</Box>
			) : (
				<Box flexDirection="column" marginTop={1}>
					<Text color="white">{scroll > 0 ? `↑ ${scroll} more` : " "}</Text>
					{shown.map((row) =>
						"topic" in row ? (
							<Text
								key={`c:${row.topic}`}
								color="whiteBright"
								bold
								wrap="truncate"
							>
								{row.topic}
							</Text>
						) : (
							<Text key={row.session.id} wrap="truncate">
								{"  "}
								<Text color="white" bold>
									{row.session.name}
								</Text>
								<Text color="white">
									{row.session.branch ? ` · ${row.session.branch}` : ""} ·{" "}
									{cardText(row.session).replace(/^Archived\. ?/, "") ||
										"archived"}
								</Text>
							</Text>
						),
					)}
					<Text color="white">{below > 0 ? `↓ ${below} more` : " "}</Text>
				</Box>
			)}
		</TitledBox>
	);
}

/** Recent replies (design 4a): Tab in a reply opens it; the master's pick is first. */
export function RecentReplies({
	replies,
	pick,
	selected,
}: {
	replies: string[];
	pick: string | null;
	selected: number;
}) {
	return (
		<TitledBox
			title="recent replies"
			titleColor="whiteBright"
			borderStyle="single"
			borderColor="white"
			width={50}
			fill="black"
			right={<Text color="white"> ↑↓ Enter Esc </Text>}
		>
			{replies.map((reply, i) => (
				<Box key={reply} justifyContent="space-between">
					<Text inverse={i === selected} wrap="truncate">
						{reply === pick ? <Text color="magenta">◆ </Text> : "  "}
						{reply}
					</Text>
					{reply === pick ? (
						<Box flexShrink={0} marginLeft={1}>
							<Text color="gray">master's pick</Text>
						</Box>
					) : null}
				</Box>
			))}
			<Box marginTop={1}>
				<Text color="white">type to write your own</Text>
			</Box>
		</TitledBox>
	);
}

/**
 * Import picker (ADR 0016): claude sessions running in tmux in this repo
 * that the map does not track. All are ticked; Space toggles, Enter imports.
 */
export function ImportDialog({
	candidates,
	onSubmit,
	onClose,
}: {
	candidates: ImportCandidate[];
	onSubmit: (claudeSessionIds: string[]) => Promise<void>;
	onClose: () => void;
}) {
	const [selected, setSelected] = useState(0);
	const [chosen, setChosen] = useState(
		() => new Set(candidates.map((c) => c.claudeSessionId)),
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const toggle = (id: string) =>
		setChosen((set) => {
			const next = new Set(set);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	useInput((input, key) => {
		if (busy) return;
		if (key.escape) return onClose();
		if (key.upArrow || input === "w")
			return setSelected((i) => Math.max(0, i - 1));
		if (key.downArrow || input === "s")
			return setSelected((i) => Math.min(candidates.length - 1, i + 1));
		const current = candidates[selected];
		if (input === " " && current) return toggle(current.claudeSessionId);
		if (input === "a")
			return setChosen(
				chosen.size === candidates.length
					? new Set()
					: new Set(candidates.map((c) => c.claudeSessionId)),
			);
		if (key.return) {
			if (!chosen.size) return onClose();
			setBusy(true);
			setError(null);
			onSubmit([...chosen]).catch((e: Error) => {
				setBusy(false);
				setError(e.message);
			});
		}
	});

	return (
		<TitledBox
			title="Import sessions"
			titleColor="whiteBright"
			borderStyle="single"
			borderColor="white"
			width={72}
			fill="black"
			right={<Text color="white"> ↑↓ Space Enter Esc </Text>}
		>
			<Text color="white">
				Claude sessions running in your tmux, in this repo. They stay where they
				are; Enter on a card jumps to their window.
			</Text>
			{candidates.map((c, i) => {
				const g = glyph(c.status);
				// A pointer and bright text, not inverse: inverse turns the row and
				// its grey and status colours into light backgrounds that are hard to read.
				const current = i === selected;
				return (
					<Box key={c.claudeSessionId} flexDirection="column" marginTop={1}>
						<Box justifyContent="space-between">
							<Text color={current ? "whiteBright" : undefined} wrap="truncate">
								<Text color="magenta">{current ? "› " : "  "}</Text>
								{chosen.has(c.claudeSessionId) ? "[x] " : "[ ] "}
								{g ? <Text color={g.color}>{g.ch} </Text> : "  "}
								<Text bold>{c.name}</Text>
								{c.branch ? (
									<Text color={current ? "white" : "gray"}> · {c.branch}</Text>
								) : null}
							</Text>
							<Box flexShrink={0} marginLeft={1}>
								<Text color={current ? "white" : "gray"}>{c.location}</Text>
							</Box>
						</Box>
						<Text color="white" wrap="truncate">
							{"        "}
							{c.title ?? c.lastPrompt ?? "no prompt yet"}
						</Text>
					</Box>
				);
			})}
			<Box marginTop={1} justifyContent="space-between">
				<Text color="white">
					<Key>a</Key> all / none
				</Text>
				<Text color={error ? "red" : "white"} wrap="truncate">
					{error ??
						(busy
							? "importing…"
							: `Enter imports ${chosen.size} of ${candidates.length}`)}
				</Text>
			</Box>
		</TitledBox>
	);
}

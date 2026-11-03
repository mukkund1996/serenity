import { homedir } from "node:os";
import {
	type BaseSetting,
	type ConfigChange,
	describeBaseSetting,
	MAX_TOPICS_RANGE,
	type Method,
	MODEL_CHOICES,
	type Params,
	type Result,
	type SettingsView,
} from "@serenity/core";
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { Key, TitledBox } from "./components";
import { CURSOR, editField, type Field, fieldAt } from "./text-input";

const PANEL_W = 64;
const LABEL_W = 14;

type Call = <M extends Method>(
	method: M,
	params: Params<M>,
) => Promise<Result<M>>;

type Role = "chat" | "summarizer" | "suggester";

/** The panel's rows, in order (ADR 0058). */
export type SettingsRow =
	| "baseRepo"
	| "baseGlobal"
	| "model:chat"
	| "model:summarizer"
	| "model:suggester"
	| "maxTopics"
	| "slack";

export const SETTINGS_ROWS: SettingsRow[] = [
	"baseRepo",
	"baseGlobal",
	"model:chat",
	"model:summarizer",
	"model:suggester",
	"maxTopics",
	"slack",
];

/** A repo's base choices: follow all repos (null), then the three settings. "branch" asks for a name. */
type BaseChoice = null | "default" | "current" | "branch";
const REPO_BASES: BaseChoice[] = [null, "default", "current", "branch"];
const GLOBAL_BASES: BaseChoice[] = ["default", "current", "branch"];

const choiceOf = (setting: BaseSetting | null): BaseChoice =>
	setting === null || typeof setting === "string" ? setting : "branch";

/** The next item of `list` after `current`, `step` places on, wrapping round. */
export function stepChoice<T>(list: T[], current: T, step: 1 | -1): T {
	const at = list.indexOf(current);
	const from = Math.max(at, 0);
	return list[(from + step + list.length) % list.length] as T;
}

/** The models to step through: the aliases, and a custom id from the file. */
export function modelChoices(current: string): string[] {
	return MODEL_CHOICES.includes(current)
		? MODEL_CHOICES
		: [...MODEL_CHOICES, current];
}

const tilde = (path: string) => {
	const home = homedir();
	return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
};

/** A text field being edited in place of a row's value: a branch name or a number. */
interface Editing {
	row: SettingsRow;
	field: Field;
}

/**
 * Settings (Ctrl+, or `,` on the map, ADR 0058): a few config.json options,
 * each saved as soon as it changes. The daemon owns the file, so it reads
 * and writes it here, and applies what it can at once.
 */
export function SettingsPanel({
	repo,
	call,
	onClose,
}: {
	repo: string;
	call: Call;
	onClose: () => void;
}) {
	const [view, setView] = useState<SettingsView | null>(null);
	const [row, setRow] = useState<SettingsRow>("baseRepo");
	const [editing, setEditing] = useState<Editing | null>(null);
	const [status, setStatus] = useState<{ text: string; error: boolean } | null>(
		null,
	);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		call("config.get", { repo }).then(setView, (e: Error) =>
			setStatus({ text: e.message, error: true }),
		);
	}, [call, repo]);

	const save = (change: ConfigChange) => {
		setBusy(true);
		call("config.set", { repo, change }).then(
			({ view, applies }) => {
				setView(view);
				setStatus({ text: `saved · ${applies}`, error: false });
				setBusy(false);
			},
			(e: Error) => {
				setStatus({ text: e.message, error: true });
				setBusy(false);
			},
		);
	};

	const setBase = (target: "baseRepo" | "baseGlobal", value: BaseChoice) => {
		if (value === "branch") {
			const now =
				target === "baseRepo" ? view?.baseBranch.repo : view?.baseBranch.global;
			const name = now && typeof now === "object" ? now.branch : "";
			return setEditing({ row: target, field: fieldAt(name) });
		}
		if (target === "baseRepo")
			save({ key: "baseBranch", scope: "repo", repo, value });
		else if (value !== null)
			save({ key: "baseBranch", scope: "global", value });
	};

	/** Enter, Space, ← and →: the row's next or previous value. */
	const change = (step: 1 | -1, enter: boolean) => {
		if (!view) return;
		if (row === "baseRepo" || row === "baseGlobal") {
			const list = row === "baseRepo" ? REPO_BASES : GLOBAL_BASES;
			const now = choiceOf(
				row === "baseRepo" ? view.baseBranch.repo : view.baseBranch.global,
			);
			// Enter on a named branch edits the name rather than moving on.
			if (enter && now === "branch") return setBase(row, "branch");
			return setBase(row, stepChoice(list, now, step));
		}
		if (row.startsWith("model:")) {
			const role = row.slice(6) as Role;
			const now = view.models[role];
			return save({
				key: "model",
				role,
				value: stepChoice(modelChoices(now), now, step),
			});
		}
		if (row === "maxTopics") {
			if (enter)
				return setEditing({ row, field: fieldAt(String(view.maxTopics)) });
			const [min, max] = MAX_TOPICS_RANGE;
			const next = Math.min(max, Math.max(min, view.maxTopics + step));
			if (next !== view.maxTopics) save({ key: "maxTopics", value: next });
			return;
		}
		if (row === "slack") save({ key: "slack", repo, value: !view.slack });
	};

	const finishEdit = (edit: Editing) => {
		setEditing(null);
		const text = edit.field.text.trim();
		if (edit.row === "maxTopics") {
			const n = Number(text);
			const [min, max] = MAX_TOPICS_RANGE;
			if (!Number.isInteger(n) || n < min || n > max)
				return setStatus({
					text: `max topics is a whole number from ${min} to ${max}`,
					error: true,
				});
			return save({ key: "maxTopics", value: n });
		}
		if (!text) return setStatus({ text: "name a branch", error: true });
		const value = { branch: text };
		if (edit.row === "baseRepo")
			save({ key: "baseBranch", scope: "repo", repo, value });
		else save({ key: "baseBranch", scope: "global", value });
	};

	useInput(
		(input, key) => {
			if (editing) {
				if (key.escape) return setEditing(null);
				if (key.return) return finishEdit(editing);
				const edit = editField(editing.field, input, key);
				if (!edit) return;
				const next = { ...editing, field: edit.field };
				if (edit.submit) return finishEdit(next);
				setEditing(next);
				return;
			}
			if (key.escape || (key.ctrl && input === ",")) return onClose();
			if (key.upArrow || key.downArrow || key.tab) {
				const step = key.upArrow || (key.tab && key.shift) ? -1 : 1;
				setRow(stepChoice(SETTINGS_ROWS, row, step));
				return;
			}
			if (busy) return;
			if (key.return) return change(1, true);
			if (input === " " || key.rightArrow) return change(1, false);
			if (key.leftArrow) return change(-1, false);
		},
		{ isActive: true },
	);

	const value = (r: SettingsRow, text: string, color?: string) => {
		const selected = r === row;
		const field = editing?.row === r ? editing.field : null;
		return (
			<Box>
				<Box width={LABEL_W} flexShrink={0}>
					<Text color={selected ? "whiteBright" : "white"}>
						{selected ? "› " : "  "}
						{LABELS[r]}
					</Text>
				</Box>
				<Box backgroundColor={selected ? "gray" : undefined} flexGrow={1}>
					{field ? (
						<Text color="whiteBright" wrap="truncate">
							{field.text}
							{CURSOR}
						</Text>
					) : (
						<Text color={color ?? "whiteBright"} wrap="truncate">
							{text}
						</Text>
					)}
				</Box>
			</Box>
		);
	};

	const heading = (text: string) => (
		<Box marginTop={1}>
			<Text color="whiteBright" bold>
				{text}
			</Text>
		</Box>
	);

	const resolved = view?.baseBranch.resolved;
	return (
		<TitledBox
			title="Settings"
			titleColor="whiteBright"
			fill="black"
			borderStyle="double"
			borderColor="white"
			width={PANEL_W}
			right={<Text color="white"> Esc close </Text>}
		>
			<Text color="gray" wrap="truncate-start">
				{view ? tilde(view.path) : "reading config…"}
			</Text>
			{view ? (
				<>
					{heading("BASE BRANCH")}
					{value(
						"baseRepo",
						view.baseBranch.repo === null
							? `as all repos (${describeBaseSetting(view.baseBranch.global)})`
							: describeBaseSetting(view.baseBranch.repo),
					)}
					{value("baseGlobal", describeBaseSetting(view.baseBranch.global))}
					<Box>
						<Box width={LABEL_W} flexShrink={0} />
						<Text color={resolved?.notice ? "yellow" : "gray"} wrap="wrap">
							{resolved?.notice ??
								`new sessions here branch off ${resolved?.ref ?? "?"}`}
						</Text>
					</Box>
					{heading("MASTER MODELS")}
					{value("model:chat", view.models.chat)}
					{value("model:summarizer", view.models.summarizer)}
					{value("model:suggester", view.models.suggester)}
					{heading("TOPICS")}
					{value("maxTopics", String(view.maxTopics))}
					{heading("SLACK")}
					{value(
						"slack",
						view.slack ? "on" : "off",
						view.slack ? "green" : "white",
					)}
				</>
			) : null}
			<Box marginTop={1}>
				<Text color={status?.error ? "red" : "green"} wrap="wrap">
					{status?.text ?? " "}
				</Text>
			</Box>
			<Text color="white">
				{editing ? (
					<>
						<Key>Enter</Key> save <Key>Esc</Key> cancel
					</>
				) : (
					<>
						<Key>↑↓</Key> move <Key>Enter Space</Key> change <Key>←→</Key> step{" "}
						<Key>Esc</Key> close
					</>
				)}
			</Text>
		</TitledBox>
	);
}

const LABELS: Record<SettingsRow, string> = {
	baseRepo: "This repo",
	baseGlobal: "All repos",
	"model:chat": "Chat",
	"model:summarizer": "Summarizer",
	"model:suggester": "Suggester",
	maxTopics: "Max topics",
	slack: "This repo",
};

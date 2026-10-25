import type { CreateSessionParams, SessionMode } from "@serenity/core";
import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { Key, TitledBox } from "./components";
import { splitAtNewline } from "./text-input";

const DIALOG_W = 64;
const FIELDS = ["name", "cwd", "branch", "mode"] as const;
type Field = (typeof FIELDS)[number];

/** New session dialog (design 4d): name, working dir, new worktree or existing branch. */
export function NewSessionDialog({
	repo,
	onSubmit,
	onClose,
}: {
	repo: string;
	onSubmit: (params: CreateSessionParams) => Promise<void>;
	onClose: () => void;
}) {
	const [values, setValues] = useState({ name: "", cwd: repo, branch: "" });
	const [mode, setMode] = useState<SessionMode>("worktree");
	const [field, setField] = useState<Field>("name");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useInput(
		(input, key) => {
			if (key.escape) return onClose();
			if (key.tab) {
				const step = key.shift ? FIELDS.length - 1 : 1;
				setField(
					FIELDS[(FIELDS.indexOf(field) + step) % FIELDS.length] as Field,
				);
				return;
			}
			const submit = (v: typeof values) => {
				if (!v.name.trim()) return setError("Give the session a name.");
				setBusy(true);
				setError(null);
				onSubmit({
					repo,
					name: v.name.trim().replace(/\s+/g, "-"),
					cwd: v.cwd,
					mode,
					branch: v.branch || undefined,
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
			if (key.backspace || key.delete) {
				setValues({ ...values, [field]: values[field].slice(0, -1) });
				return;
			}
			if (input && !key.ctrl && !key.meta) {
				const { text, submit: enter } = splitAtNewline(input);
				const next = { ...values, [field]: values[field] + text };
				setValues(next);
				if (enter) return submit(next);
			}
			setError(null);
		},
		{ isActive: !busy },
	);

	const row = (label: string, f: Exclude<Field, "mode">, placeholder = "") => (
		<Box marginTop={1}>
			<Box width={13} flexShrink={0}>
				<Text color="gray">{label}</Text>
			</Box>
			<Box backgroundColor={field === f ? "gray" : undefined} flexGrow={1}>
				<Text wrap="truncate-start">
					{values[f] ? (
						<Text color="whiteBright">{values[f]}</Text>
					) : (
						<Text color={field === f ? "black" : "gray"}>{placeholder}</Text>
					)}
					{field === f ? <Text color="whiteBright">█</Text> : null}
				</Text>
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
			right={<Text color="gray"> Esc close </Text>}
		>
			{row("Name", "name")}
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
				<Text color="gray">
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

const SHORTCUTS: Array<[string, Array<[string, string]>]> = [
	[
		"MOVE",
		[
			["Tab ⇧Tab", "next / previous waiting"],
			["W A S D", "move between cards"],
		],
	],
	[
		"ON A NODE",
		[
			["i", "reply"],
			["Enter", "attach · Ctrl+g back"],
			["n", "new session"],
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
			width={46}
			right={
				<Text color="gray">
					{" "}
					<Key>?</Key> hide{" "}
				</Text>
			}
		>
			{SHORTCUTS.map(([section, keys]) => (
				<Box key={section} flexDirection="column" marginTop={1}>
					<Text color="gray">{section}</Text>
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
				<Text color="gray">STATUS</Text>
				<Text>
					<Text color="yellow">◐</Text> waiting <Text color="blue">●</Text> in
					progress <Text color="green">✓</Text> finished
				</Text>
				<Text color="gray">name in grey = idle</Text>
			</Box>
			<Box marginTop={1}>
				<Text color="gray">
					<Key>q</Key> quits the map · sessions keep running
				</Text>
			</Box>
		</TitledBox>
	);
}

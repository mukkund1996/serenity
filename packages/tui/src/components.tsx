import type { Canvas, Color, Session } from "@serenity/core";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { askLine, cardText, glyph, nameColor } from "./theme";

const ink = (color: Color | undefined) =>
	color && color !== "default" ? color : undefined;

export function CanvasView({ canvas }: { canvas: Canvas }) {
	return (
		<Box flexDirection="column" width={canvas.width} height={canvas.height}>
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
	children,
}: {
	title: string;
	titleColor: Color;
	borderStyle: "round" | "single" | "double";
	borderColor: Color;
	width: number;
	right?: ReactNode;
	children: ReactNode;
}) {
	return (
		<Box position="relative" flexDirection="column" width={width}>
			<Box
				borderStyle={borderStyle}
				borderColor={ink(borderColor)}
				flexDirection="column"
				paddingX={2}
				width={width}
			>
				{children}
			</Box>
			<Box position="absolute" marginLeft={2}>
				<Text color={ink(titleColor)} bold>{` ${title} `}</Text>
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

function MasterInput() {
	return (
		<Box borderStyle="single" borderColor="gray" marginTop={1}>
			<Text color="gray">
				<Text color="magenta">›</Text> message master…
			</Text>
		</Box>
	);
}

/** Master panel in the topics zoom: NEEDS YOU plus the (milestone 2) conversation. */
export function MasterPanel({
	width,
	sessions,
	needs,
	calmCategories,
}: {
	width: number;
	sessions: Session[];
	needs: Session[];
	calmCategories: number;
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
						{needs.length > 0 ? (
							<Text color="yellow">
								{needs.length}{" "}
								{needs.length === 1 ? "session needs" : "sessions need"} you
							</Text>
						) : (
							<Text color="gray">nothing needs you</Text>
						)}
						{calmCategories > 0 ? (
							<Text color="gray">
								{" "}
								· {calmCategories}{" "}
								{calmCategories === 1 ? "category" : "categories"} calm
							</Text>
						) : null}
					</Text>
					{needs.length > 0 ? (
						<>
							<SectionHeader
								label={`NEEDS YOU ${needs.length}`}
								width={inner}
							/>
							{needs.map((s) => (
								<Box key={s.id} flexDirection="column">
									<SessionLine session={s} />
									<Box paddingLeft={2}>
										<Text color="gray" wrap="truncate">
											{askLine(s)}
										</Text>
									</Box>
								</Box>
							))}
						</>
					) : null}
					<SectionHeader label="CONVERSATION" width={inner} />
					<Text color="gray" dimColor>
						The master joins in the next milestone.
					</Text>
				</>
			)}
			<MasterInput />
		</TitledBox>
	);
}

/** Floating master in the session zoom (design screen 3). */
export function SessionMaster({
	width,
	session,
	others,
}: {
	width: number;
	session: Session;
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
			<Text color="white">{cardText(session)}</Text>
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
			<MasterInput />
		</TitledBox>
	);
}

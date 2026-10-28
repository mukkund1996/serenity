/** Markdown imported `with { type: "text" }`, bundled into the binary. */
declare module "*.md" {
	const text: string;
	export default text;
}

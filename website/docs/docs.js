// Shared script for every page under website/docs/: copy buttons on command blocks,
// the sidebar marking the section in view, and the phone menu closing after a pick.

let copyTimer = 0;
for (const btn of document.querySelectorAll(".d-copy")) {
	const label = btn.getAttribute("aria-label");
	btn.addEventListener("click", () => {
		const pre = btn.parentElement.querySelector("pre");
		const text = Array.from(pre.childNodes)
			.filter((n) => !(n.nodeType === 1 && n.classList.contains("p")))
			.map((n) => n.textContent)
			.join("")
			.trim();
		const done = () => {
			for (const other of document.querySelectorAll(".d-copy.is-copied")) {
				other.classList.remove("is-copied");
				other.setAttribute("aria-label", other.dataset.label);
			}
			btn.dataset.label = label;
			btn.classList.add("is-copied");
			btn.setAttribute("aria-label", "Copied");
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => {
				btn.classList.remove("is-copied");
				btn.setAttribute("aria-label", label);
			}, 1600);
		};
		try {
			if (navigator.clipboard?.writeText)
				navigator.clipboard.writeText(text).then(done, done);
			else done();
		} catch {
			done();
		}
	});
}

const side = document.querySelector(".d-side");
const links = new Map(
	Array.from(document.querySelectorAll('.d-side a[href^="#"]'), (a) => [
		a.getAttribute("href").slice(1),
		a,
	]),
);
const sections = Array.from(links.keys(), (id) =>
	document.getElementById(id),
).filter(Boolean);

function markHere() {
	let here = sections[0];
	for (const s of sections) if (s.getBoundingClientRect().top < 120) here = s;
	for (const [id, a] of links)
		a.classList.toggle("is-here", here && id === here.id);
}
document.addEventListener("scroll", markHere, { passive: true });
markHere();

// The phone menu is a <details>; open it by default on wide screens, close it after a pick on phones.
const wide = window.matchMedia("(min-width: 900px)");
const syncSide = () => {
	side.open = wide.matches;
};
wide.addEventListener?.("change", syncSide);
syncSide();
for (const a of links.values()) {
	a.addEventListener("click", () => {
		if (!wide.matches) side.open = false;
	});
}

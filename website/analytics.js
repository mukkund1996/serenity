// GoatCounter events shared by every page of the website (no cookies, no personal data).
// count.js loads async and may be blocked, so every call is optional. Events:
//   star-<page>-nav, star-landing-install   Star on GitHub (data-goatcounter-click in the markup)
//   story-watch                             the landing story's WATCH button (same)
//   install-copy-<quick|curl|brew>          a landing copy button (site.js)
//   docs-copy: <command>                    a docs copy button (docs/docs.js)
//   reached-install                         the landing #install section came into view (site.js)
//   outbound: <host/path>                   any other link off the site (below)
// Owner opt-out: loading any page with #toggle-goatcounter makes count.js set (or clear)
// localStorage skipgc, after which it sends nothing from that browser: page views, the
// data-goatcounter-click events and srnEvent alike all go through goatcounter.count().
// It also skips localhost, LAN addresses and file://. See CONTRIBUTING.md (Maintainers).

window.srnEvent = (path, title) => {
	try {
		window.goatcounter?.count?.({ path, title, event: true });
	} catch {}
};

document.addEventListener(
	"click",
	(e) => {
		const a = e.target.closest?.("a[href]");
		if (!a || a.hasAttribute("data-goatcounter-click")) return;
		const url = new URL(a.href, location.href);
		if (url.host === location.host || !url.protocol.startsWith("http")) return;
		window.srnEvent(
			`outbound: ${url.host}${url.pathname}${url.hash}`.replace(/\/$/, ""),
			a.textContent.trim().replace(/\s+/g, " ").slice(0, 80) || url.href,
		);
	},
	{ capture: true },
);

// count.js only reads #toggle-goatcounter when the page loads. Adding the hash to a page
// already open is just a jump within that page, so reload to let count.js see it.
window.addEventListener("hashchange", () => {
	if (location.hash === "#toggle-goatcounter") location.reload();
});

// The scroll story and the copy buttons. Ported from the Design canvas's Main.dc.html:
// render() is its renderVals() unchanged; elements carry their style as a data-st
// template whose {{holes}} are filled from render()'s result on every scroll frame.

const track = document.getElementById("srn-track");
const stage = document.getElementById("srn-stage");

const lookup = (vals, path) =>
	path.split(".").reduce((o, k) => (o == null ? o : o[k]), vals);

const bound = Array.from(document.querySelectorAll("[data-st]"), (el) => ({
	el,
	parts: el.getAttribute("data-st").split(/{{\s*([\w.]+)\s*}}/),
	last: "",
}));
const texts = Array.from(document.querySelectorAll("[data-t]"), (el) => ({
	el,
	key: el.getAttribute("data-t"),
	last: el.textContent,
}));

const state = { p: 0, vw: 1280, vh: 900 };
let raf = 0;

function apply() {
	const vals = render(state);
	for (const b of bound) {
		let css = "";
		for (let i = 0; i < b.parts.length; i++) {
			css += i % 2 ? (lookup(vals, b.parts[i]) ?? "") : b.parts[i];
		}
		if (css !== b.last) {
			b.el.setAttribute("style", css);
			b.last = css;
		}
	}
	for (const t of texts) {
		const v = String(vals[t.key]);
		if (v !== t.last) {
			t.el.textContent = v;
			t.last = v;
		}
	}
}

function tick() {
	raf = 0;
	const r = track.getBoundingClientRect();
	const sh = stage.offsetHeight;
	const sw = stage.offsetWidth;
	const span = Math.max(1, r.height - sh);
	const p = Math.min(1, Math.max(0, -r.top / span));
	// lay out for the part of the stage that is actually on screen
	const vis = Math.min(sh, window.innerHeight || sh);
	if (Math.abs(p - state.p) > 0.0003 || sw !== state.vw || vis !== state.vh) {
		state.p = p;
		state.vw = sw;
		state.vh = vis;
		apply();
	}
}

function onScroll() {
	if (!raf) raf = requestAnimationFrame(tick);
}

function render(st) {
	// pAll runs the whole scroll; the window story (p) uses the first 60%, the word pairs the rest
	const raw = st.p;
	// pauses: at each [point, length] the story holds still for that much scroll before the next animation
	// the scroll story ends at serenity centre stage (pAll 0.6), then rests briefly;
	// the later node pull-out / word-pair act is skipped (its code stays inert past 0.6)
	const holds = [
		[0.03, 0.03],
		[0.096, 0.025],
		[0.145, 0.025],
		[0.21, 0.03],
		[0.285, 0.025],
		[0.345, 0.02],
		[0.405, 0.02],
		[0.51, 0.025],
	];
	const storyEnd = 0.6;
	const tailRest = 0.04;
	const holdSum = holds.reduce((a, h) => a + h[1], 0);
	const pAll = (() => {
		const x = raw * (storyEnd + holdSum + tailRest);
		let acc = 0;
		for (let i = 0; i < holds.length; i++) {
			const a = holds[i][0];
			const d = holds[i][1];
			if (x <= a + acc) return x - acc;
			if (x <= a + acc + d) return a;
			acc += d;
		}
		return Math.min(storyEnd, x - acc);
	})();
	const p = Math.min(1, pAll / 0.6);

	const cl = (x) => Math.min(1, Math.max(0, x));
	const seg = (a, b) => cl((p - a) / (b - a));
	const segA = (a, b) => cl((pAll - a) / (b - a));
	const ss = (t) => t * t * (3 - 2 * t);
	const eo = (t) => 1 - (1 - t) ** 3;
	const eio = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
	const L = (a, b, t) => a + (b - a) * t;
	const n = (v, d) => Number(v.toFixed(d == null ? 2 : d));

	// ---- stage fit ----
	// story: viewBox x 90..1190, y 10..720; centre stage: zoom to serenity's window (x 100..1180, y 70..710)
	const vw = st.vw || 1280;
	const vh = st.vh || 900;
	// phones get their own framing: tighter crops, stack under serenity, nodes pulled out below it
	const mob = vw < 640;
	const top = 64;
	const capH = vw < 640 ? 100 : 64;
	const gap = vw < 640 ? 16 : 24;
	// once serenity shrinks (sh), room is made at the bottom for the word pairs and their subtitles;
	// the staggered problem words sit in the top headline spot and run into the empty top of the scene
	const sh = eio(segA(0.62, 0.67));
	const avail = vh - top - gap - capH - 52;
	const tcS = eio(seg(0.86, 0.94)) * (1 - sh);
	// while the stack sits to the right of serenity, the view widens to x -70..1350 (same centre)
	const pmS = ss(seg(0.38, 0.46));
	const wFit = mob
		? L(L(720, 920, pmS), 600, sh)
		: L(1100, 1420, pmS * (1 - sh));
	const s0 = Math.max(0.2, Math.min(1.1, (vw * 0.94) / wFit, avail / 710));
	const sF = Math.max(
		0.2,
		Math.min(
			1.15,
			(vw * (mob ? 0.94 : 0.8)) / 1080,
			((avail + 24) * 0.85) / 640,
		),
	);
	const s = L(s0, sF, tcS);
	const vbH = L(710, 640, tcS);
	const vbTop = L(10, 70, tcS);
	const sceneH = vbH * s;
	// headlines sit in a fixed spot right under the top bar; the scene fills the space below
	const capTop = top + 36;
	// at centre stage the headline spot is empty, so serenity is centred in the whole space under the top bar
	const startY0 = capTop + capH + gap + Math.max(0, (avail - sceneH) / 2);
	const startYC = top + Math.max(0, (vh - top - 16 - sceneH) / 2);
	const startY = L(startY0, startYC, tcS);
	const scene = `left:${n(vw / 2 - 640 * s, 1)}px;top:${n(startY - vbTop * s, 1)}px;transform:scale(${n(s, 4)})`;
	// captions stay in one fixed spot below the scene
	const capBand = `top:${n(capTop, 1)}px`;

	// glow: grows slowly from below the bottom edge, then moves up behind serenity's window centre (scene 640,390)
	const gGrow = ss(seg(0, 0.86));
	const gw0 = L(vw * 0.22, vw * 1.3, gGrow);
	const gh0 = L(vh * 0.14, vh * 0.95, gGrow);
	const gcy0 = vh + gh0 * 0.05;
	const gw1 = 1080 * s * 1.2;
	const gh1 = 640 * s * 1.25;
	const gcy1 = startY - vbTop * s + 390 * s;
	const gw = L(gw0, gw1, tcS);
	const gh = L(gh0, gh1, tcS);
	const gcy = L(gcy0, gcy1, tcS);
	const glow = `left:${n(vw / 2 - gw / 2, 1)}px;top:${n(gcy - gh / 2, 1)}px;width:${n(gw, 1)}px;height:${n(gh, 1)}px;opacity:${n(L(0.3, 1, gGrow), 3)}`;

	// ---- phases ----
	// 0.00–0.32  windows stack into a neat cascade (the pile)
	// 0.38–0.46  the pile shrinks to the right; serenity appears in the middle
	// 0.50–0.83  windows are pulled left one by one and coalesce into nodes
	// 0.86–0.94  serenity moves to centre stage
	const pm = ss(seg(0.38, 0.46));
	const pk = L(1, 0.34, pm);
	// windows pile up loosely around (640, 320): small random-looking offsets and tilts so the stack reads as a big heap
	const pdx = L(0, mob ? 0 : 582, pm);
	const pdy = L(0, mob ? 320 : -18, pm);
	const ax = 640;
	const ay = 320;
	const front =
		p < 0.095
			? "c1"
			: p < 0.135
				? "c3"
				: p < 0.205
					? "c2"
					: p < 0.285
						? "vs"
						: "sl";
	const lights = (k) =>
		front === k && pm < 0.5
			? { r: "#ff5f57", y: "#febc2e", g: "#28c840" }
			: { r: "#4a4a4e", y: "#4a4a4e", g: "#4a4a4e" };

	// serenity window pose: docked in the middle (scale .82), then centre stage (scale 1)
	const ta = ss(seg(0.42, 0.5));
	const tc = eio(seg(0.86, 0.94));
	// after centre stage (pAll .62–.67) serenity shrinks to the top-left third
	const tsc = L(L(0.82, 1, tc), 0.5, sh);
	const se = tsc * (0.96 + 0.04 * ta);
	const tx = L(L(197.2, 100, tc), mob ? 370 : 160, sh) + 540 * (tsc - se);
	const ty = L(L(mob ? 20 : 40, 70, tc), 20, sh) + 320 * (tsc - se);
	const tui = `opacity:${n(ta, 3)};visibility:${ta <= 0.001 ? "hidden" : "visible"};transform:translate(${n(tx, 1)}px,${n(ty, 1)}px) scale(${n(se, 4)})`;
	const node = (r) => ({
		x: tx + r.x * se,
		y: ty + r.y * se,
		w: r.w * se,
		h: r.h * se,
	});

	// nodes pulled out to the right, enlarged, one at a time: agent, waiting, master
	const out1 = eio(segA(0.67, 0.72)) * (1 - eio(segA(0.78, 0.82)));
	const out2 = eio(segA(0.78, 0.83)) * (1 - eio(segA(0.89, 0.93)));
	const out3 = eio(segA(0.89, 0.94));
	const spot = { vs: out1, c2: out2, sl: out3 };
	const spotCx = mob ? 640 : 990;
	const spotCy = mob ? 520 : 180;
	const spotRect = (r, k2) => ({
		w: r.w * k2,
		h: r.h * k2,
		x: spotCx - (r.w * k2) / 2,
		y: spotCy - (r.h * k2) / 2,
	});

	// A = window in the pile (scene px), N = its node inside serenity (serenity px)
	const defs = {
		c1: {
			A: { x: 360, y: 150, w: 560, h: 340, r: 0 },
			N: { x: 780, y: 145, w: 250, h: 100 },
			enter: null,
			pull: [0.74, 0.84],
			z: 2,
		},
		c3: {
			A: { x: 315, y: 190, w: 540, h: 320, r: -2.2 },
			N: { x: 50, y: 375, w: 250, h: 100 },
			enter: [0.07, 0.12],
			pull: [0.71, 0.81],
			z: 3,
		},
		c2: {
			A: { x: 435, y: 130, w: 540, h: 330, r: 1.8 },
			N: { x: 780, y: 375, w: 250, h: 100 },
			enter: [0.11, 0.16],
			pull: [0.68, 0.78],
			z: 4,
		},
		vs: {
			A: { x: 310, y: 145, w: 600, h: 380, r: -1.4 },
			N: { x: 50, y: 145, w: 250, h: 100 },
			enter: [0.17, 0.24],
			pull: [0.58, 0.68],
			z: 5,
		},
		sl: {
			A: { x: 400, y: 120, w: 560, h: 380, r: 2.4 },
			N: { x: 360, y: 165, w: 360, h: 290 },
			enter: [0.25, 0.32],
			pull: [0.48, 0.58],
			z: 6,
		},
	};

	const ent = (k) => {
		const d = defs[k];
		let ex = 1;
		let op = 1;
		if (d.enter) {
			ex = eo(seg(d.enter[0], d.enter[1]));
			op = seg(d.enter[0], d.enter[0] + (d.enter[1] - d.enter[0]) * 0.45);
		}
		const P = {
			x: ax + (d.A.x - ax) * pk + pdx,
			y: ay + (d.A.y - ay) * pk + pdy,
			w: d.A.w * pk,
			h: d.A.h * pk,
		};
		const N = node(d.N);
		const t = seg(d.pull[0], d.pull[1]);
		const tp = eio(t);
		const tz = eio(cl((t - 0.15) / 0.85));
		const cx = L(P.x + P.w / 2, N.x + N.w / 2, tp);
		const cy = L(P.y + P.h / 2, N.y + N.h / 2, tp);
		const u = spot[k] || 0;
		const S = spotRect(d.N, k === "sl" ? 1.05 : 1.5);
		const w = L(L(P.w, N.w, tz), S.w, u);
		const h = L(L(P.h, N.h, tz), S.h, u);
		const x = L(cx, S.x + S.w / 2, u) - w / 2;
		const y = L(cy, S.y + S.h / 2, u) - h / 2;
		const rot = L(d.A.r + (1 - ex) * 2 * (d.A.r < 0 ? -1 : 1), 0, tp);
		const dy = (1 - ex) * 120;
		const sc = 0.96 + 0.04 * ex;
		const aOp = 1 - ss(cl((t - 0.3) / 0.5));
		const bOp = ss(cl((t - 0.5) / 0.45));
		const sa = Math.min(w / d.A.w, h / d.A.h);
		const sb = Math.min(w / d.N.w, h / d.N.h);
		const z = (t > 0 && t < 1) || u > 0.001 ? 9 : d.z;
		const box = `left:${n(x, 1)}px;top:${n(y, 1)}px;width:${n(w, 1)}px;height:${n(h, 1)}px;z-index:${z};opacity:${n(op, 3)};visibility:${op <= 0.001 ? "hidden" : "visible"};transform:translateY(${n(dy, 1)}px) rotate(${n(rot, 2)}deg) scale(${n(sc, 3)})`;
		const a = `width:${d.A.w}px;height:${d.A.h}px;opacity:${n(aOp, 3)};visibility:${aOp <= 0.001 ? "hidden" : "visible"};transform:translate(${n((w - d.A.w * sa) / 2, 1)}px,${n((h - d.A.h * sa) / 2, 1)}px) scale(${n(sa, 4)})`;
		const b = `width:${d.N.w}px;height:${d.N.h}px;opacity:${n(bOp, 3)};visibility:${bOp <= 0.001 ? "hidden" : "visible"};transform:translate(${n((w - d.N.w * sb) / 2, 1)}px,${n((h - d.N.h * sb) / 2, 1)}px) scale(${n(sb, 4)})`;
		const dim = `opacity:${n(pm * 0.38 * (1 - ss(cl(t / 0.4))), 3)}`;
		return { box, a, b, dim, tl: lights(k) };
	};

	// ---- serenity header, footer, links ----
	const fin = ss(seg(0.9, 0.95));
	const chip = `opacity:${n(fin, 3)}`;
	const footer = `opacity:${n(0.4 + 0.6 * fin, 3)}`;

	// left links: trunk, spine and top branch draw as VS Code lands; the bottom branch as the third Claude lands
	const lt = seg(0.65, 0.71);
	const lTrunk = ss(cl(lt / 0.35));
	const lSpine = ss(cl((lt - 0.3) / 0.35));
	const lB1 = ss(cl((lt - 0.6) / 0.4));
	const lB2 = ss(seg(0.79, 0.84));
	const rt = seg(0.8, 0.86);
	const trunk = ss(cl(rt / 0.35));
	const spine = ss(cl((rt - 0.3) / 0.35));
	const branch = ss(cl((rt - 0.6) / 0.4));

	// ---- chaos details ----
	const tIn1 = eo(seg(0.29, 0.32));
	const tIn2 = eo(seg(0.33, 0.36));
	const tOut = ss(seg(0.38, 0.42));
	const toast = (tin) =>
		`opacity:${n(tin * (1 - tOut), 3)};transform:translateX(${n((1 - tin) * 360 + tOut * 360, 1)}px);visibility:${tin * (1 - tOut) <= 0.001 ? "hidden" : "visible"}`;
	const eng = 1 + Math.round(ss(seg(0.26, 0.38)) * 7);
	const dm = 1 + Math.round(ss(seg(0.3, 0.38)) * 2);
	const act = 2 + Math.round(ss(seg(0.28, 0.38)) * 9);
	const vsBadge = 3 + Math.round(ss(seg(0.21, 0.38)) * 4);

	// ---- captions ----
	const fade = (o) =>
		`opacity:${n(o, 3)};transform:translateY(${n((1 - o) * 12, 1)}px);visibility:${o <= 0.001 ? "hidden" : "visible"}`;
	const c0 = 1 - ss(seg(0.035, 0.06));
	const cThen = ss(seg(0.06, 0.08)) * (1 - ss(seg(0.11, 0.13)));
	const wo1 = ss(seg(0.13, 0.16));
	const wo2 = ss(seg(0.2, 0.23));
	const wo3 = ss(seg(0.28, 0.31));
	const bright = "#e8eaee";
	const dimText = "#6b717b";
	const word = (o, current) =>
		`opacity:${n(o, 3)};color:${current ? bright : dimText};transition:color .4s`;
	const c2 = ss(seg(0.44, 0.49)) * (1 - ss(seg(0.84, 0.87)));
	const thenTop = Math.max(0, startY + (150 - vbTop) * s - 130 - capTop);

	// each problem word sits in the open space left of the window pile (right-aligned to scene x 328), stepping down as its window lands
	const sideFs = mob ? 26 : Math.max(20, Math.min(44, 40 * s));
	// phones have no room beside the pile: the three words share one centred line where "and then…" was
	const rowEnds = (() => {
		const ws = [7, 11, 5].map((c) => c * 0.46 * sideFs);
		const gapW = sideFs * 0.4;
		let x = (vw - (ws[0] + ws[1] + ws[2] + 2 * gapW)) / 2;
		return ws.map((w) => {
			x += w;
			const end = x;
			x += gapW;
			return end;
		});
	})();
	const sceneL = vw / 2 - 640 * s;
	const sceneT = startY - vbTop * s;
	const rowOut = 1 - ss(seg(0.38, 0.43));
	const side = (wxEnd, wy, chars, o, current, idx) => {
		// right-aligned: every word's right edge sits on the same line
		const w = chars * 0.46 * sideFs;
		const xEnd = mob
			? rowEnds[idx]
			: Math.max(w + 12, Math.min(vw - 12, sceneL + wxEnd * s));
		const y = mob ? capTop + thenTop : sceneT + wy * s;
		return `right:${n(vw - xEnd, 1)}px;top:${n(y, 1)}px;font-size:${n(sideFs, 1)}px;${word(o, current)};transform:translateX(${n((1 - o) * -14, 1)}px);visibility:${o <= 0.001 ? "hidden" : "visible"}`;
	};
	// Clutter with the 2nd Claude window, Distraction with the editor, Noise with the chat app
	const side1 = side(240, 166, 7, wo1 * rowOut, p < 0.2, 0);
	const side2 = side(240, 254, 11, wo2 * rowOut, p >= 0.2 && p < 0.28, 1);
	const side3 = side(240, 352, 5, wo3 * rowOut, p >= 0.28, 2);

	return {
		scene,
		capBand,
		tui,
		chip,
		footer,
		lnLTrunk: `transform:scaleX(${n(lTrunk, 3)})`,
		lnLSpine: `transform:scaleY(${n(lSpine, 3)})`,
		lnLB1: `transform:scaleX(${n(lB1, 3)})`,
		lnLB2: `transform:scaleX(${n(lB2, 3)})`,
		dotL1: `opacity:${n(cl((lB1 - 0.7) / 0.3), 3)}`,
		dotL2: `opacity:${n(cl((lB2 - 0.7) / 0.3), 3)}`,
		c3: ent("c3"),
		lnTrunk: `transform:scaleX(${n(trunk, 3)})`,
		lnSpine: `transform:scaleY(${n(spine, 3)})`,
		lnBranch: `transform:scaleX(${n(branch, 3)})`,
		dotR: `opacity:${n(cl((branch - 0.7) / 0.3), 3)}`,
		c1: ent("c1"),
		c2: ent("c2"),
		vs: ent("vs"),
		sl: ent("sl"),
		toast1: toast(tIn1),
		toast2: toast(tIn2),
		engBadge: eng,
		dmBadge: dm,
		actBadge: act,
		vsBadge,
		cap0: fade(c0),
		glow,
		side1,
		side2,
		side3,
		capThen: `top:${n(thenTop, 1)}px;${fade(cThen)}`,
		cap2: fade(c2),
		// phones: tighter nav so logo, GitHub and the version pill fit on one line
		navGap: mob ? "16px" : "24px",
		hint: `top:${n(vh - 36, 1)}px;opacity:${n(1 - ss(seg(0, 0.03)), 3)}`,
	};
}

// ---- copy buttons ----
const commands = {
	quick:
		"curl -fsSL https://raw.githubusercontent.com/mukkund1996/serenity/main/scripts/install.sh | sh",
	curl: "curl -fsSL https://raw.githubusercontent.com/mukkund1996/serenity/main/scripts/install.sh | sh",
	brew: "brew install --cask claude-code; brew install mukkund1996/tap/serenity",
};
let copyTimer = 0;
for (const btn of document.querySelectorAll("[data-copy]")) {
	const label = btn.getAttribute("aria-label");
	btn.addEventListener("click", () => {
		const done = () => {
			for (const other of document.querySelectorAll("[data-copy].is-copied")) {
				other.classList.remove("is-copied");
				other.setAttribute("aria-label", other.dataset.label);
				other.title = other.dataset.label;
			}
			btn.dataset.label = label;
			btn.classList.add("is-copied");
			btn.setAttribute("aria-label", "Copied");
			btn.title = "Copied";
			clearTimeout(copyTimer);
			copyTimer = setTimeout(() => {
				btn.classList.remove("is-copied");
				btn.setAttribute("aria-label", label);
				btn.title = label;
			}, 1600);
		};
		try {
			if (navigator.clipboard?.writeText) {
				navigator.clipboard
					.writeText(commands[btn.dataset.copy])
					.then(done, done);
			} else {
				done();
			}
		} catch {
			done();
		}
	});
}

document.addEventListener("scroll", onScroll, { passive: true, capture: true });
window.addEventListener("resize", onScroll);
if (window.ResizeObserver) new ResizeObserver(onScroll).observe(stage);
// first frame: force a render even when the measured state equals the defaults
state.p = -1;
tick();

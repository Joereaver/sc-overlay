// Widget-canvas DOM tests — `npm run test:widgets` (needs `npm run overlay` on :8778).
//
// WHY ELECTRON AND NOT A HEADLESS SCREENSHOT: missions.html holds an SSE connection and the
// widget pages run repeating timers, so `msedge --headless --screenshot` never completes on them.
// Loading the REAL page in a hidden Electron window is both the runtime it actually ships in and
// the only way to assert on live DOM state. Read-only against the sidecar — it just opens another
// SSE client.
//
// Suite 1 runs with no shell API (fresh install) and exercises grouping.
// Suite 2 injects a stub preload reporting a saved layout, and checks the restore path.
const { app, BrowserWindow } = require("electron");
const path = require("path");

// Piping this run into `head`/`grep -m` closes stdout early, and the next console.log then throws
// EPIPE — which Electron surfaces as a "JavaScript error in the main process" DIALOG, on top of
// whatever the user was doing. Swallow it: a closed pipe means nobody is reading, not a failure.
process.stdout.on("error", (e) => { if (e && e.code !== "EPIPE") throw e; });
process.stderr.on("error", (e) => { if (e && e.code !== "EPIPE") throw e; });

const PORT = process.env.OVERLAY_PORT || 8778;
const URL = `http://localhost:${PORT}/missions.html?canvas=1&party&mining&notepad`;

const PRELUDE = `
  const out = [];
  const ok = (n, c, d) => out.push({ name: n, pass: !!c, detail: d === undefined ? "" : String(d) });
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  // The Blueprint panel is a LOCAL registry widget: it lives in this document rather than an
  // iframe, so it has no w-/wf- elements and hides via a body class.
  const el = (w) => (w.local ? document.getElementById("panel") : document.getElementById("w-" + w.key));
  const shown = (w) => (w.local
    ? !document.body.classList.contains("bp-hidden")
    : el(w).style.display !== "none");
  const cs = (w, v) => el(w).style.getPropertyValue(v);
  await sleep(900); // let the async layout loader settle
  // A hidden window never composites, so CSS transitions don't advance and a mid-slide transform
  // would be read as "still parked". Assert on settled geometry instead.
  const noAnim = document.createElement("style");
  noAnim.textContent = ".whead,.tape,.bolt,.corner{transition:none !important}";
  document.head.appendChild(noAnim);
`;

// ── Suite 1: grouping behaviour ────────────────────────────────────────────────
const GROUPING = `(async () => {
  ${PRELUDE}
  const saved = [];
  window.overlayApi = Object.assign({}, window.overlayApi, {
    saveWidget: (id, l) => saved.push([id, JSON.parse(JSON.stringify(l))]),
  });

  ok("registry has 9 widgets (incl. the Blueprint panel)", typeof WIDGETS !== "undefined" && WIDGETS.length === 9, typeof WIDGETS !== "undefined" ? WIDGETS.length : "unreachable");
  ok("starts ungrouped", GROUPS.length === 0, GROUPS.length);
  const party = WBY.party, mining = WBY.mining, notepad = WBY.notepad;
  ok("test widgets shown", shown(party) && shown(mining) && shown(notepad));

  groupWidgets(party, mining);
  const g = GROUPS[0];
  ok("one group created", GROUPS.length === 1);
  ok("members are mining+party", g && g.members.join(",") === "mining,party", g && g.members.join(","));
  ok("dropped widget becomes active", g && g.active === "party", g && g.active);
  ok("active member shown", shown(party));
  ok("inactive member hidden", !shown(mining));
  // The whole point of not reparenting: a backgrounded tab keeps its iframe, so chat scrollback,
  // unsaved notes and live SSE all survive being tabbed away from.
  ok("inactive member NOT unloaded", !!document.getElementById("wf-mining").src, "iframe src kept");
  ok("members share x", cs(party,"--wx") === cs(mining,"--wx"), cs(party,"--wx") + " vs " + cs(mining,"--wx"));
  ok("members share width", cs(party,"--ww") === cs(mining,"--ww"), cs(party,"--ww") + " vs " + cs(mining,"--ww"));
  ok("no widget is scale-based any more (all responsive)", !document.querySelector(".widget.scaled"));
  ok("members flagged .grouped", el(party).classList.contains("grouped") && el(mining).classList.contains("grouped"));

  const strip = el(WBY[GROUPS[0] ? GROUPS[0].active : "party"]).querySelector(".wh-tabs");
  ok("tab strip rendered", !!strip);
  const tabs = strip ? [...strip.querySelectorAll(".gtab:not(.gdetach)")].map(b => b.dataset.k) : [];
  ok("a tab per member", tabs.join(",") === "mining,party", tabs.join(","));
  ok("detach button present", !!(strip && strip.querySelector(".gdetach")));
  ok("tabs live in the fronted member's own bar", !!(strip && strip.closest(".whead")));
  ok("grouped bar is pinned OUT (tabs must stay visible)",
     getComputedStyle(el(WBY[g.active]).querySelector(".whead")).transform.replace(/ /g, "") === "matrix(1,0,0,1,0,0)",
     getComputedStyle(el(WBY[g.active]).querySelector(".whead")).transform);
  ok("grouped widget shows tabs instead of its name",
     getComputedStyle(el(WBY[g.active]).querySelector(".wh-id")).display === "none");

  strip.querySelector('.gtab[data-k="mining"]').click();
  await sleep(30);
  ok("clicking a tab swaps the visible member", shown(mining) && !shown(party));

  groupWidgets(notepad, party);
  ok("third member joins existing group", GROUPS.length === 1 && GROUPS[0].members.length === 3, GROUPS[0] && GROUPS[0].members.join(","));
  detachFromGroup(WBY[GROUPS[0].active]);
  ok("group survives with 2 after detach", GROUPS.length === 1 && GROUPS[0].members.length === 2, GROUPS[0] && GROUPS[0].members.join(","));

  detachFromGroup(WBY[GROUPS[0].active]);
  ok("group dissolves below 2 members", GROUPS.length === 0, GROUPS.length);
  ok("no tabs once dissolved", ![...document.querySelectorAll(".wh-tabs")].some(t => t.innerHTML.trim()));
  // Regression: applyFrame() reads groupOf(), so the group must be dropped BEFORE re-applying the
  // survivor, or the last member stays flagged as grouped.
  ok("survivors standalone again", !el(party).classList.contains("grouped") && !el(mining).classList.contains("grouped"));
  ok("mining stays responsive after ungrouping", !el(mining).classList.contains("scaled"));

  groupWidgets(party, mining);
  const gs = saved.filter(s => s[0] === "__groups").pop();
  ok("groups persisted under __groups", !!gs && Array.isArray(gs[1].list), gs ? JSON.stringify(gs[1]).slice(0, 110) : "none");
  setWidgetVisible(WBY.party, false);
  ok("closing a tab leaves the stack", GROUPS.length === 0, GROUPS.length);
  return out;
})()`;

// ── Suite 2: BRUTE-FORCE every pair merge ─────────────────────────────────────
// Sub hit a real bug merging Twitch chat with the Mining Assistant: the Mining panel came back
// cut off, and stayed broken even after separating them. Rather than test the pairs he happened
// to try, group and ungroup ALL 28 combinations and assert the widget is whole afterwards.
const PAIRS = `(async () => {
  ${PRELUDE}
  // Show everything so every pair is actually mergeable.
  for (const w of WIDGETS) { setWidgetVisible(w, true); }
  await sleep(500);

  const frameBox = (w) => (w.local ? el(w).getBoundingClientRect() : document.getElementById("wf-" + w.key).getBoundingClientRect());
  // 🔑 The frame being the right size proves NOTHING about whether the widget is usable — Sub's
  // mining+party breakage had a perfectly sized frame with the panel inside it clipped. So look
  // INSIDE the iframe and check the page's own panel actually fits the box it was given.
  const innerFit = (w) => {
    try {
      if (w.local) return null; // its content IS this document; nothing to reach into
      const doc = document.getElementById("wf-" + w.key).contentDocument;
      const panel = doc && (doc.getElementById("panel") || doc.getElementById("card"));
      if (!panel) return null;
      const f = frameBox(w), p = panel.getBoundingClientRect();
      return { overflowX: Math.round(p.width - f.width), overflowY: Math.round(p.height - f.height) };
    } catch { return null; }
  };
  const fits = (w) => { const o = innerFit(w); return !o || (o.overflowX <= 2 && o.overflowY <= 2); };
  // Snapshot each widget's healthy standalone frame size to compare against after a merge cycle.
  const baseline = {};
  for (const w of WIDGETS) { const r = frameBox(w); baseline[w.key] = [Math.round(r.width), Math.round(r.height)]; }

  const broken = [], groupBad = [], clipped = [];
  for (let i = 0; i < WIDGETS.length; i++) {
    for (let j = i + 1; j < WIDGETS.length; j++) {
      const a = WIDGETS[i], b = WIDGETS[j];
      groupWidgets(a, b);
      const g = GROUPS[0];
      // While grouped: one box, exactly one member on screen, and it must have real size.
      const vis = g ? g.members.filter(k => shown(WBY[k])) : [];
      const fr = frameBox(WBY[g ? g.active : a.key]);
      if (!g || g.members.length !== 2 || vis.length !== 1 || fr.width < 20 || fr.height < 20) {
        groupBad.push(a.key + "+" + b.key + " (members=" + (g ? g.members.length : 0) + " visible=" + vis.length +
                      " frame=" + Math.round(fr.width) + "x" + Math.round(fr.height) + ")");
      }
      // The fronted member's CONTENT must fit the shared box - this is the check that catches a
      // widget rendering clipped inside a perfectly-sized frame.
      const act = WBY[g ? g.active : a.key];
      if (!fits(act)) {
        const o = innerFit(act);
        clipped.push(a.key + "+" + b.key + " grouped -> " + act.key + " overflows by " + o.overflowX + "x" + o.overflowY);
      }
      // Ungroup. A widget INHERITING the stack's box is intended (you sized that stack on
      // purpose), so don't demand the original size back. What must never happen is what Sub hit:
      // a widget landing at a size nobody chose, or shrinking/growing a bit more on every cycle.
      while (GROUPS.length) detachFromGroup(WBY[GROUPS[0].active]);
      await sleep(60); // mining re-measures on a timer
      const cycle1 = {};
      for (const w of [a, b]) { const r = frameBox(w); cycle1[w.key] = [Math.round(r.width), Math.round(r.height)]; }
      for (const w of [a, b]) {
        const got = cycle1[w.key];
        if (got[0] < 100 || got[1] < 60) broken.push(a.key + "+" + b.key + " -> " + w.key + " degenerate " + got.join("x"));
        if (!fits(w)) {
          const o = innerFit(w);
          clipped.push(a.key + "+" + b.key + " ungrouped -> " + w.key + " overflows by " + o.overflowX + "x" + o.overflowY);
        }
      }
      // Same cycle again: the size must SETTLE, not drift further each time.
      groupWidgets(a, b);
      while (GROUPS.length) detachFromGroup(WBY[GROUPS[0].active]);
      await sleep(60);
      for (const w of [a, b]) {
        const r = frameBox(w), got = [Math.round(r.width), Math.round(r.height)], was = cycle1[w.key];
        if (Math.abs(got[0] - was[0]) > 4 || Math.abs(got[1] - was[1]) > 4) {
          broken.push(a.key + "+" + b.key + " -> " + w.key + " DRIFTS " + was.join("x") + " then " + got.join("x"));
        }
      }
      // put them back where they started so the next pair starts clean
      for (const w of [a, b]) { resetWidget(w); }
      await sleep(40);
    }
  }
  ok("all 28 pairs group cleanly", groupBad.length === 0, groupBad.slice(0, 4).join(" | "));
  ok("no pair leaves a widget's CONTENT clipped inside its box", clipped.length === 0,
     clipped.length + " clipped: " + clipped.slice(0, 5).join(" | "));
  ok("no pair leaves a widget degenerate or drifting", broken.length === 0,
     broken.length + " broken: " + broken.slice(0, 4).join(" | "));
  await sleep(200);
  ok("every widget's content fits its box after all that", WIDGETS.every(fits),
     WIDGETS.filter(w => !fits(w)).map(w => w.key + " " + JSON.stringify(innerFit(w))).join(" | "));

  // The two pairs Sub called out by name, end to end. What matters is that the CONTENT fits both
  // while stacked and after separating - frame size alone never revealed the bug.
  for (const partner of ["twitchChat", "party"]) {
    groupWidgets(WBY.mining, WBY[partner]);
    await sleep(80);
    const gOk = fits(WBY[GROUPS[0].active]);
    detachFromGroup(WBY.mining);
    await sleep(200);
    ok("mining+" + partner + ": content fits stacked AND after separating",
       gOk && fits(WBY.mining) && fits(WBY[partner]),
       "stacked=" + gOk + " mining=" + JSON.stringify(innerFit(WBY.mining)) + " " + partner + "=" + JSON.stringify(innerFit(WBY[partner])));
    resetWidget(WBY.mining); resetWidget(WBY[partner]);
  }
  return out;
})()`;

// ── Suite 3: title-bar chrome (parked behind the widget, slides out on hover) ──
const CHROME = `(async () => {
  ${PRELUDE}
  const w = WBY.party;
  const box = () => el(w).getBoundingClientRect();
  const hood = el(w).querySelector(".whood");
  const bar = el(w).querySelector(".whead");
  ok("every widget has a title bar", [...document.querySelectorAll(".widget")].every(e => e.querySelector(".whood > .whead")));
  ok("bar carries move/reset/settings/close", bar.querySelectorAll(".wh-right .wh-btn").length === 4,
     bar.querySelectorAll(".wh-right .wh-btn").length);
  // The name lives in the page's own header; the bar only names things when widgets are stacked.
  ok("bar does NOT repeat the widget name", getComputedStyle(bar.querySelector(".wh-id")).display === "none");

  // The hood hangs ABOVE the widget, so the bar can never cover content.
  const hr = hood.getBoundingClientRect();
  ok("hood sits below the widget", Math.abs(hr.top - box().bottom) < 1, "hood.top=" + hr.top.toFixed(1) + " widget.bottom=" + box().bottom.toFixed(1));
  ok("hood clips its contents", getComputedStyle(hood).overflow === "hidden", getComputedStyle(hood).overflow);

  // At rest the bar is pushed fully below the hood => clipped away to nothing.
  el(w).classList.remove("touched");
  const parked = bar.getBoundingClientRect();
  ok("bar is PARKED behind the widget at rest", parked.bottom <= hr.top + 1,
     "bar.bottom=" + parked.bottom.toFixed(1) + " hood.top=" + hr.top.toFixed(1));
  ok("parked bar is not clickable", getComputedStyle(bar).pointerEvents === "none", getComputedStyle(bar).pointerEvents);

  // Slid out: it occupies the strip ABOVE the widget and stops exactly at its top edge.
  el(w).classList.add("touched");
  const outR = bar.getBoundingClientRect();
  ok("bar slides OUT below the widget", outR.top >= box().bottom - 1 && outR.bottom > box().bottom,
     "bar=" + outR.top.toFixed(1) + ".." + outR.bottom.toFixed(1) + " widget.bottom=" + box().bottom.toFixed(1));
  ok("slid-out bar covers NO widget content", outR.top >= box().bottom - 1);
  ok("slid-out bar is clickable", getComputedStyle(bar).pointerEvents === "auto");
  ok("bar spans the widget width", Math.abs(outR.width - box().width) < 2, outR.width.toFixed(1) + " vs " + box().width.toFixed(1));

  // The shell must only be told about the bar while it's out, or a parked bar leaves a
  // permanently clickable strip hanging over the game.
  const RSEL = ".widget:hover .whead, .widget.touched .whead";
  ok("slid-out bar IS reported to the shell", [...document.querySelectorAll(RSEL)].includes(bar));
  el(w).classList.remove("touched");
  ok("parked bar is NOT reported to the shell", ![...document.querySelectorAll(RSEL)].includes(bar));

  // Arrange mode hands the whole widget to the drag shield.
  // Arrange mode KEEPS the bar out: it's the drag handle, and the thing you aim at to stack
  // widgets (drag one bar onto another).
  el(w).classList.add("moving");
  ok("bar stays OUT in arrange mode (it's the drag handle)",
     getComputedStyle(hood).display !== "none" &&
     getComputedStyle(bar).transform.replace(/ /g, "") === "matrix(1,0,0,1,0,0)",
     getComputedStyle(bar).transform);
  ok("bar's buttons go inert while arranging", getComputedStyle(bar.querySelector(".wh-btn")).pointerEvents === "none");
  el(w).classList.remove("moving");

  // ── manufacturer trinkets ──────────────────────────────────────────────────
  // They are the skin's IDENTITY, not chrome: visible at all times, including while the bar is
  // parked, and the bottom one travels with the bar instead of being covered or hidden.
  const mw = WBY.mining;
  const root = document.documentElement, theme0 = root.getAttribute("data-theme");
  ok("flair widget is marked", el(mw).classList.contains("flair"));
  const tTr = el(mw).querySelector(".tape.tr"), tBl = el(mw).querySelector(".tape.bl");
  ok("trinkets sit top-right and bottom-left", !!tTr && !!tBl);
  ok("no trinkets on a non-flair widget", !el(WBY.notepad).querySelector(".tape.tr, .corner.tr"));

  root.setAttribute("data-theme", "mobiglas");
  ok("no trinket on a theme that has none", getComputedStyle(tTr).display === "none", getComputedStyle(tTr).display);
  root.setAttribute("data-theme", "drake");
  ok("Drake shows its tape", getComputedStyle(tTr).display === "block", getComputedStyle(tTr).display);

  // The requirement Sub called out: they must NOT disappear with the bar.
  el(mw).classList.remove("touched");
  ok("trinkets stay visible while the bar is PARKED",
     getComputedStyle(tTr).display === "block" && getComputedStyle(tBl).display === "block");
  const blParked = tBl.getBoundingClientRect().top;
  el(mw).classList.add("touched");
  const blOut = tBl.getBoundingClientRect().top;
  const barH = parseFloat(getComputedStyle(el(mw).querySelector(".whead")).height);
  ok("bottom trinket travels DOWN with the bar", Math.abs((blOut - blParked) - barH) < 2,
     "moved " + (blOut - blParked).toFixed(1) + "px, bar is " + barH.toFixed(1) + "px");
  ok("top trinket stays put", Math.abs(el(mw).querySelector(".tape.tr").getBoundingClientRect().top - tTr.getBoundingClientRect().top) < 0.5);
  el(mw).classList.remove("touched");

  root.setAttribute("data-theme", "argo");
  ok("Argo shows its cog", /cog-argo/.test(getComputedStyle(el(mw).querySelector(".corner.tr")).backgroundImage));
  if (theme0) root.setAttribute("data-theme", theme0); else root.removeAttribute("data-theme");
  const mbar = el(mw).querySelector(".whead");

  // ── per-widget settings cog ────────────────────────────────────────────────
  // It opens THAT widget's own panel, so it only exists where the page exposes one. It must never
  // quietly stand in for global settings (those live on the global cog and the tray).
  for (let i = 0; i < 40 && !el(mw).classList.contains("has-settings"); i++) await sleep(50); // iframe load
  ok("Mining exposes its own settings", typeof document.getElementById("wf-mining").contentWindow.__widgetSettings === "function");
  ok("Mining is detected as having its own settings", el(mw).classList.contains("has-settings"));
  const np = WBY.notepad;
  // EVERY widget has a cog now - it carries text size, which they all have. Only the pass-through
  // to a page's own settings panel depends on that page having one.
  ok("every widget has a cog", WIDGETS.every(x => getComputedStyle(el(x).querySelector(".wh-cog")).display !== "none"));
  ok("a page's OWN settings menu gets the Text size row injected",
     !!document.getElementById("wf-mining").contentWindow.__widgetSettingsRoot().querySelector(".wtext-row"));

  // ── the Blueprint panel carries the same bar ───────────────────────────────
  const bp = document.getElementById("panel");
  const bpbar = bp.querySelector(".whood > .whead");
  ok("Blueprint panel has the bar too", !!bpbar);
  ok("Blueprint bar has all four controls", bpbar && bpbar.querySelectorAll(".wh-right .wh-btn").length === 4,
     bpbar && bpbar.querySelectorAll(".wh-right .wh-btn").length);
  ok("Blueprint's old top-right chrome is gone", !!document.getElementById("grip") && !!document.getElementById("grip").closest(".whead"));
  // NB the panel carries a 3D perspective tilt, so its projected rect and a child's don't share
  // an edge — assert the LAYOUT invariant (the hood is pinned to the panel's bottom) instead.
  const bphood = bp.querySelector(".whood");
  ok("Blueprint bar hangs below the panel", bphood && bp.clientHeight > 0 &&
     Math.abs(bphood.getBoundingClientRect().top - bp.getBoundingClientRect().bottom) < 14,
     bphood && ("hood.top=" + bphood.getBoundingClientRect().top.toFixed(0) +
                " panel.bottom=" + bp.getBoundingClientRect().bottom.toFixed(0)));
  if (theme0) root.setAttribute("data-theme", theme0); else root.removeAttribute("data-theme");

  return out;
})()`;

// ── Suite 5: every control is actually VISIBLE and REACHABLE ──────────────────
// Three separate bugs this session were the same shape: a control that exists, is display:block,
// and does nothing — because an ancestor's overflow:hidden clipped it away (mining's cog menu, the
// settings popover) or it sat outside every region the shell hit-tests (so the click went to the
// game). getBoundingClientRect() is happily non-zero in both cases, so only an explicit check
// finds them. This suite opens each widget's chrome and proves you could actually click it.
const REACH = `(async () => {
  ${PRELUDE}
  for (const w of WIDGETS) setWidgetVisible(w, true);
  await sleep(400);

  // Intersect an element's rect with every clipping ancestor's rect. Anything that survives with
  // real area is genuinely on screen; anything that doesn't has been clipped away.
  let lastClipper = "";
  const visibleArea = (node) => {
    let r = node.getBoundingClientRect();
    let x0 = r.left, y0 = r.top, x1 = r.right, y1 = r.bottom;
    lastClipper = "";
    for (let p = node.parentElement; p; p = p.parentElement) {
      const st = getComputedStyle(p);
      // An ancestor only clips if it establishes a clipping box; a scrollable one still shows what
      // is inside its padding box. html/body are the viewport and never count as clippers here.
      if (p === document.body || p === document.documentElement) continue;
      if (st.overflow === "visible" && st.overflowX === "visible" && st.overflowY === "visible") continue;
      const pr = p.getBoundingClientRect();
      const nx0 = Math.max(x0, pr.left), ny0 = Math.max(y0, pr.top);
      const nx1 = Math.min(x1, pr.right), ny1 = Math.min(y1, pr.bottom);
      if ((nx1 - nx0) * (ny1 - ny0) < (x1 - x0) * (y1 - y0)) {
        lastClipper = p.tagName + "." + String(p.className).split(" ")[0];
      }
      x0 = nx0; y0 = ny0; x1 = nx1; y1 = ny1;
    }
    return Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  };
  // The shell only routes clicks to rects this page reports; anything outside them hits the game.
  const RSEL = "#panel, #globalCog, #hub, #cogMenu, #whatsnew, #arrangeScrim .ab, .widget:not(.notifier), .widget.notifier.live, .widget.notifier.moving, .widget.notifier.cfgopen, .widget:hover .whead, .widget.touched .whead, .widget.grouped .whead, #panel:hover .whead, #panel.touched .whead";
  const reachable = (node) => {
    const r = node.getBoundingClientRect();
    const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
    return [...document.querySelectorAll(RSEL)].some((reg) => {
      const q = reg.getBoundingClientRect();
      return cx >= q.left && cx <= q.right && cy >= q.top && cy <= q.bottom;
    });
  };

  const clipped = [], unreachable = [];
  for (const w of WIDGETS) {
    const el = w.local ? document.getElementById("panel") : document.getElementById("w-" + w.key);
    el.classList.add("touched"); // bar out, the way hovering it would
    // the bar's own controls
    for (const b of el.querySelectorAll(".wh-right .wh-btn")) {
      const cls = b.className.replace("wh-btn ", "");
      if (visibleArea(b) < 25) clipped.push(w.key + " " + cls + " [clipped by " + lastClipper + "]");
      else if (!reachable(b)) unreachable.push(w.key + " " + cls);
    }
    // and whatever its cog opens - the page's own menu, or the local popover
    el.querySelector(".wh-cog").click();
    await sleep(20);
    if (el.classList.contains("has-settings")) {
      let root = null; try { root = w.local ? document.getElementById("cogMenu") : document.getElementById("wf-" + w.key).contentWindow.__widgetSettingsRoot(); } catch {}
      if (!root || !root.querySelector(".wtext-row")) clipped.push(w.key + " own-menu text row missing");
    } else {
      const cfg = el.querySelector(".wcfg");
      if (!cfg) {
        clipped.push(w.key + " has no settings surface at all");
      } else if (visibleArea(cfg) < 400) {
        clipped.push(w.key + " popover area=" + Math.round(visibleArea(cfg)) + " [clipped by " + lastClipper + "]");
      } else {
        if (!reachable(cfg)) unreachable.push(w.key + " settings popover");
        for (const b of cfg.querySelectorAll(".wh-btn")) {
          if (getComputedStyle(b).display === "none") continue;
          if (visibleArea(b) < 25) clipped.push(w.key + " popover " + b.className.replace("wh-btn ", ""));
        }
      }
    }
    el.classList.remove("cfgopen");
    el.classList.remove("touched");
  }
  ok("no widget control is clipped away by an ancestor", clipped.length === 0, clipped.slice(0, 6).join(" | "));
  ok("every widget control sits inside a reported click region", unreachable.length === 0, unreachable.slice(0, 6).join(" | "));

  // The cog must actually DO something - a dead control that merely exists is the bug we keep
  // hitting. There are two shapes: a page with its own settings sheet opens THAT, everything else
  // opens the local popover. Check one of each.
  const w0 = WBY.notepad, e0 = document.getElementById("w-notepad");
  e0.classList.add("touched");
  e0.querySelector(".wh-cog").click(); await sleep(20);
  ok("a widget with no page settings opens a visible popover",
     e0.classList.contains("cfgopen") && visibleArea(e0.querySelector(".wcfg")) > 400,
     "cfgopen=" + e0.classList.contains("cfgopen") + " area=" + Math.round(visibleArea(e0.querySelector(".wcfg"))));
  const e1 = document.getElementById("w-party");
  e1.classList.add("touched");
  e1.querySelector(".wh-cog").click(); await sleep(40);
  let sheetOpen = false;
  try { sheetOpen = document.getElementById("wf-party").contentDocument.getElementById("wsettings").classList.contains("open"); } catch {}
  ok("a widget WITH page settings opens its own sheet", sheetOpen);
  ok("...and the Text size row was injected into that sheet",
     !!document.getElementById("wf-party").contentWindow.__widgetSettingsRoot().querySelector(".wtext-row"));
  // and text size must move
  const before = w0.s.text || 1;
  e0.querySelector(".wcfg-up").click(); await sleep(20);
  ok("text size control changes the scale", (w0.s.text || 1) > before, before + " -> " + (w0.s.text || 1));
  e0.querySelector(".wcfg-dn").click();
  e0.classList.remove("cfgopen", "touched");
  return out;
})()`;

// ── Suite 6: sweeps ───────────────────────────────────────────────────────────
// The pair suite fixes one dimension (which widgets are stacked) and holds everything else at its
// default. These sweep the OTHER dimensions - every manufacturer skin, the full size range, the
// full text-size range - because a bug in one skin or at one extreme is otherwise only ever found
// by a user. All of them assert the same thing: content stays inside the box it was given.
const THEMES = ["mobiglas", "drake", "anvil", "greys", "argo", "misc", "aegis", "crusader", "rsi",
                "mirai", "origin", "esperia", "banu", "gatac", "kruger", "cnou"];
const SWEEPS = `(async () => {
  ${PRELUDE}
  for (const w of WIDGETS) setWidgetVisible(w, true);
  await sleep(500);

  const frameBox = (w) => (w.local ? el(w).getBoundingClientRect()
                                   : document.getElementById("wf-" + w.key).getBoundingClientRect());
  const innerFit = (w) => {
    try {
      if (w.local) return null;
      const doc = document.getElementById("wf-" + w.key).contentDocument;
      const panel = doc && (doc.getElementById("panel") || doc.getElementById("card"));
      if (!panel) return null;
      const f = frameBox(w), pr = panel.getBoundingClientRect();
      return { ox: Math.round(pr.width - f.width), oy: Math.round(pr.height - f.height) };
    } catch { return null; }
  };
  const fits = (w) => { const o = innerFit(w); return !o || (o.ox <= 2 && o.oy <= 2); };
  const root = document.documentElement, theme0 = root.getAttribute("data-theme");
  const THEMES = ${JSON.stringify(THEMES)};

  // ── theme sweep: every skin, every widget ───────────────────────────────────
  // A skin is a token swap plus per-theme trinket images, so the things that break are a missing
  // asset (renders as nothing) and a rule that changes layout.
  const themeBad = [], missingArt = [];
  for (const th of THEMES) {
    root.setAttribute("data-theme", th);
    for (const w of WIDGETS) { syncWidgetTheme(w); }
    await sleep(30);
    for (const w of WIDGETS) {
      if (!fits(w)) themeBad.push(th + "/" + w.key + " " + JSON.stringify(innerFit(w)));
      const box = frameBox(w);
      if (box.width < 40 || box.height < 40) themeBad.push(th + "/" + w.key + " collapsed");
    }
    // trinket art actually resolves (a 404 renders as an empty box, silently)
    for (const sel of [".tape.tr", ".tape.bl", ".corner.tr", ".corner.bl", ".bolt.tr", ".bolt.bl"]) {
      for (const node of document.querySelectorAll(".flair " + sel)) {
        if (getComputedStyle(node).display === "none") continue;
        if (node.tagName === "IMG") { if (!node.complete || node.naturalWidth === 0) missingArt.push(th + " " + sel); }
        else {
          const bg = getComputedStyle(node).backgroundImage;
          if (!bg || bg === "none") missingArt.push(th + " " + sel + " (no image)");
        }
      }
    }
  }
  if (theme0) root.setAttribute("data-theme", theme0); else root.removeAttribute("data-theme");
  ok("every skin renders every widget without breaking layout", themeBad.length === 0, themeBad.slice(0, 5).join(" | "));
  ok("every skin's trinket art resolves", missingArt.length === 0, [...new Set(missingArt)].slice(0, 6).join(" | "));

  // ── size sweep: both ends of every widget's clamp range ─────────────────────
  const sizeBad = [];
  for (const w of WIDGETS) {
    for (const [lbl, ww, hh] of [["min", w.size.minW, w.size.minH], ["max", w.size.maxW, w.size.maxH]]) {
      if (ww == null) continue;
      w.s.w = Math.min(ww, 1600); w.s.h = Math.min(hh, 1200); // keep it inside the test viewport
      applyFrame(w); await sleep(20);
      if (!fits(w)) sizeBad.push(w.key + "@" + lbl + " " + JSON.stringify(innerFit(w)));
      const b = frameBox(w);
      if (b.width < 40 || b.height < 30) sizeBad.push(w.key + "@" + lbl + " collapsed to " + Math.round(b.width) + "x" + Math.round(b.height));
    }
    resetWidget(w);
  }
  ok("every widget survives both ends of its size range", sizeBad.length === 0, sizeBad.slice(0, 5).join(" | "));

  // ── text-size sweep: 70% to 200% ────────────────────────────────────────────
  // This is the control that replaced scaling, so it has to hold at both extremes: a widget must
  // not spill out of its box at 200%, and must not collapse at 70%.
  const textBad = [];
  for (const w of WIDGETS) {
    for (const scale of [0.7, 1, 1.5, 2]) {
      w.s.text = scale; applyTextScale(w); await sleep(25);
      if (!fits(w)) textBad.push(w.key + "@" + Math.round(scale * 100) + "% " + JSON.stringify(innerFit(w)));
    }
    w.s.text = null; applyTextScale(w);
  }
  ok("every widget holds its box from 70% to 200% text", textBad.length === 0, textBad.slice(0, 5).join(" | "));

  // ── stacks of three and four ────────────────────────────────────────────────
  // Pairs never exercise tab overflow in the bar, which is where a third and fourth tab land.
  while (GROUPS.length) detachFromGroup(WBY[GROUPS[0].active]);
  const quad = ["party", "mining", "battaglia", "notepad"].map(k => WBY[k]);
  groupWidgets(quad[1], quad[0]);
  groupWidgets(quad[2], quad[0]);
  groupWidgets(quad[3], quad[0]);
  await sleep(60);
  const g4 = GROUPS[0];
  ok("four widgets stack into one group", g4 && g4.members.length === 4, g4 && g4.members.join(","));
  const bar4 = el(WBY[g4.active]).querySelector(".whead");
  const tabs4 = bar4.querySelectorAll(".wh-tabs .gtab:not(.gdetach)").length;
  ok("the bar shows a tab per member", tabs4 === 4, tabs4);
  // the tab row must not push the controls off the bar
  const right4 = bar4.querySelector(".wh-right").getBoundingClientRect();
  const barR = bar4.getBoundingClientRect();
  ok("controls stay on the bar with four tabs",
     right4.right <= barR.right + 1 && right4.width > 20,
     "controls end " + Math.round(right4.right) + " bar ends " + Math.round(barR.right));
  ok("exactly one member of a four-stack is on screen",
     g4.members.filter(k => shown(WBY[k])).length === 1,
     g4.members.filter(k => shown(WBY[k])).join(","));
  while (GROUPS.length) detachFromGroup(WBY[GROUPS[0].active]);
  for (const w of WIDGETS) resetWidget(w);
  return out;
})()`;

// ── Suite 3: restore from a saved (and partly corrupt) layout ──────────────────
const RESTORE = `(async () => {
  ${PRELUDE}
  ok("saved group restored", GROUPS.length === 1, GROUPS.map(g => g.id).join(",") || "none");
  const g = GROUPS[0];
  ok("ghost member dropped", g && !g.members.includes("doesNotExist"), g && g.members.join(","));
  ok("group left under 2 real members is discarded", !GROUPS.some(x => x.id === "gghost"));
  ok("1-member group discarded", !GROUPS.some(x => x.id === "glone"));
  ok("restored members correct", g && g.members.join(",") === "mining,party", g && g.members.join(","));
  ok("restored active honoured", g && g.active === "party", g && g.active);
  ok("only the active member is shown", shown(WBY.party) && !shown(WBY.mining));
  ok("widget freed from a dropped group is normal", shown(WBY.notepad) && !GROUPS.some(x => x.members.includes("notepad")));
  ok("members use the GROUP's box, not their own saved spot",
     cs(WBY.party, "--wx") === "250px" && cs(WBY.mining, "--wx") === "250px",
     "party=" + cs(WBY.party,"--wx") + " mining=" + cs(WBY.mining,"--wx"));
  ok("group width applied", cs(WBY.party, "--ww") === "500px", cs(WBY.party, "--ww"));
  ok("ungrouped widget keeps its own saved spot", cs(WBY.notepad, "--wx") === "500px", cs(WBY.notepad, "--wx"));
  const strip = el(WBY[GROUPS[0] ? GROUPS[0].active : "party"]).querySelector(".wh-tabs");
  ok("tab strip restored", !!strip);
  ok("tabs restored into the fronted member's bar", !!(strip && strip.querySelector(".gtab")));
  return out;
})()`;

// ── Suite 7: dragging + reset ─────────────────────────────────────────────────
// Sub's report: "when I move the cursor near another box, the one I'm dragging freezes, then
// jumps to catch up." Cause: neighbours are IFRAMES, and a pointer over an iframe delivers its
// moves to THAT document — this window simply stops hearing them. So the load-bearing assertion
// is that a full-canvas shield sits ABOVE every widget for the duration of the gesture. Plus the
// recovery path for a widget dragged off-screen: reset centres it, and the hub can fire that
// reset without the widget's own (unreachable) bar.
const DRAG = `(async () => {
  ${PRELUDE}
  const party = WBY.party, mining = WBY.mining;
  for (const w of WIDGETS) setWidgetVisible(w, true);
  await sleep(300);
  const shield = document.getElementById("dragShield");
  ok("drag shield exists", !!shield);
  ok("shield is idle before a gesture", shield && getComputedStyle(shield).display === "none");

  // Grab party's bar and drag it across mining.
  const bar = el(party).querySelector(".whead");
  const r0 = bar.getBoundingClientRect();
  bar.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: r0.left + 40, clientY: r0.top + 8 }));
  await sleep(20);
  ok("shield is up during a drag", getComputedStyle(shield).display !== "none");
  ok("body flags the drag", document.body.classList.contains("dragging"));
  // Over a neighbour, the shield — not that widget's iframe — must be what the cursor hits.
  const mr = el(mining).getBoundingClientRect();
  const hit = document.elementFromPoint(mr.left + mr.width / 2, mr.top + mr.height / 2);
  ok("the shield covers a neighbouring widget", hit === shield, hit && (hit.id || hit.tagName));
  // ...and moves keep arriving in THIS document, which is what the freeze was.
  const x0 = party.s.x;
  window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: r0.left + 40 + 120, clientY: r0.top + 8 }));
  await sleep(20);
  ok("the widget tracks the pointer over a neighbour", party.s.x === x0 + 120, party.s.x + " vs " + (x0 + 120));
  // Every bar is out while dragging, so the drop target is something you can see.
  ok("neighbour bars come out as drop targets",
     getComputedStyle(el(mining).querySelector(".whead")).transform.replace(/ /g, "") === "matrix(1,0,0,1,0,0)",
     getComputedStyle(el(mining).querySelector(".whead")).transform);
  window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  await sleep(20);
  ok("shield drops on pointerup", getComputedStyle(shield).display === "none");
  ok("drag flag cleared", !document.body.classList.contains("dragging"));

  // Reset = the MIDDLE of the primary monitor, not the registry's starting spot: the whole point
  // is recovering a widget you can no longer reach.
  const ci = canvasInfo || { pw: window.innerWidth, ph: window.innerHeight };
  party.s.x = -4000; party.s.y = 9000; party.s.w = 800; applyFrame(party);
  resetWidget(party);
  ok("reset centres horizontally", party.s.x === Math.round((ci.pw - party.size.w) / 2), party.s.x);
  ok("reset centres vertically", party.s.y === Math.round((ci.ph - party.size.h) / 2), party.s.y);
  ok("reset drops the custom size", party.s.w === null && party.s.h === null);

  // Hub: a reset per widget, right-aligned, and clicking it must NOT toggle that widget's
  // checkbox (which is what a button inside the row's <label> would have done).
  document.getElementById("hub").classList.add("open"); // it's display:none until the cog opens it
  await sleep(20);
  const rows = [...document.querySelectorAll("#hub .hub-row.tog")];
  ok("every widget row has a reset", rows.length === WIDGETS.length
     && rows.every(r => r.querySelector(".hub-reset")), rows.length + " rows");
  ok("every reset names a real widget",
     [...document.querySelectorAll("#hub .hub-reset")].every(b => !!WBY[b.dataset.w]));
  const mRow = document.querySelector('#hub .hub-reset[data-w="mining"]').closest(".hub-row");
  const mBtn = mRow.querySelector(".hub-reset"), mChk = mRow.querySelector("input[type=checkbox]");
  ok("the reset sits right of the checkbox",
     mBtn.getBoundingClientRect().left > mChk.getBoundingClientRect().right,
     Math.round(mBtn.getBoundingClientRect().left) + " > " + Math.round(mChk.getBoundingClientRect().right));
  ok("the reset is flush right in the row",
     Math.abs(mRow.getBoundingClientRect().right - mBtn.getBoundingClientRect().right) < 20,
     Math.round(mRow.getBoundingClientRect().right - mBtn.getBoundingClientRect().right) + "px from the edge");
  const wasChecked = mChk.checked;
  mining.s.x = -4000; mining.s.y = 9000; applyFrame(mining);
  mBtn.click();
  await sleep(20);
  ok("hub reset recentres its widget", mining.s.x === Math.round((ci.pw - mining.size.w) / 2), mining.s.x);
  ok("hub reset leaves the on/off checkbox alone", mChk.checked === wasChecked);

  // Section headings: Layout means layout. Settings + patch notes are not that.
  const secOf = (id) => { let n = document.getElementById(id); while (n && !(n.classList && n.classList.contains("hub-sec"))) n = n.previousElementSibling; return n && n.textContent.trim(); };
  ok("Arrange is under Layout", secOf("hubArrange") === "Layout", secOf("hubArrange"));
  ok("full settings is NOT under Layout", secOf("hubSettings") !== "Layout", secOf("hubSettings"));
  ok("patch notes is NOT under Layout", secOf("hubWhatsNew") !== "Layout", secOf("hubWhatsNew"));
  return out;
})()`;

// ── Suite 8: the embedded pages' own headers ──────────────────────────────────
// The widget bar names the widget, so a page that ALSO carries its name says it twice (Mining
// did — it kept an old eyebrow through the header refactor). And a page's header controls belong
// on the right, opposite the title.
const HEADERS = `(async () => {
  ${PRELUDE}
  for (const w of WIDGETS) setWidgetVisible(w, true);
  await sleep(900); // iframes have to load and lay out before anything can be measured
  const docOf = (k) => { try { return document.getElementById("wf-" + k).contentDocument; } catch { return null; } };

  for (const w of WIDGETS) {
    if (w.local) continue;
    const d = docOf(w.key); if (!d || !d.querySelector(".head")) continue;
    const heads = [...d.querySelectorAll(".head")].filter(h => h.offsetParent !== null || d.defaultView.getComputedStyle(h).display !== "none");
    const txt = heads.map(h => h.textContent).join(" ").toLowerCase();
    const n = txt.split(w.title.toLowerCase()).length - 1;
    ok(w.title + ": names itself at most once in its header", n <= 1, n + "x");
  }

  // Notepad's text-size stepper and ＋ New sit at the RIGHT edge of the header (Sub, 2026-07-25).
  const nd = docOf("notepad");
  const nhead = nd.querySelector(".head.list-only");
  const title = nhead.querySelector(".h-title").getBoundingClientRect();
  const fsz = nhead.querySelector(".fsz").getBoundingClientRect();
  const nb = nd.getElementById("newBtn").getBoundingClientRect();
  const hr = nhead.getBoundingClientRect();
  ok("notepad: controls are right of the title", fsz.left > title.right + 20, Math.round(fsz.left - title.right) + "px gap");
  ok("notepad: ＋ New is flush right", Math.abs(hr.right - nb.right) < 20, Math.round(hr.right - nb.right) + "px from the edge");
  ok("notepad: text stepper and ＋ New share the row", Math.abs(fsz.top - nb.top) < 12 && fsz.right <= nb.left + 1);
  return out;
})()`;

// ── Suite 9: chrome anchoring + the header latch ──────────────────────────────
// Three bugs Sub hit in one sitting, all from the Blueprint panel being #panel rather than a
// .widget, or from the page not being told something only the shell knows.
const ANCHOR = `(async () => {
  ${PRELUDE}
  const panel = document.getElementById("panel");
  for (const w of WIDGETS) setWidgetVisible(w, true);
  await sleep(400);

  // 1. The panel's bar carries a group's TABS, so grouping must pin it out exactly like any
  //    other member's. Every ".widget.grouped" rule needs its "#panel.grouped" twin.
  // Dropped-onto-other = the one that fronts, so this is the panel fronting a stack — the case
  // that broke. (The reverse, Battaglia fronting, is just another .widget and already covered.)
  groupWidgets(WBY.blueprint, WBY.battaglia);
  await sleep(60);
  // (this preload restores a saved mining+party group too, so find the panel's own)
  const bg = GROUPS.find((x) => x.members.includes("blueprint"));
  ok("the panel is the fronted member", bg && bg.active === "blueprint", bg && bg.active);
  ok("grouping the panel flags it", panel.classList.contains("grouped"));
  const pbar = panel.querySelector(".whead");
  ok("the panel's bar stays out while grouped",
     getComputedStyle(pbar).transform.replace(/ /g, "") === "matrix(1,0,0,1,0,0)",
     getComputedStyle(pbar).transform);
  ok("its tabs are rendered", panel.querySelectorAll(".wh-tabs .gtab").length >= 2,
     panel.querySelectorAll(".wh-tabs .gtab:not(.gdetach)").length + " tabs");
  // The shell only hit-tests rects matching RSEL, so a bar that isn't in that list is unclickable.
  ok("the grouped panel's bar is a reportable region", !!document.querySelector("#panel.grouped .whead"));
  detachFromGroup(WBY.blueprint);
  await sleep(30);

  // 2. The cog lives in the BOTTOM bar, so its menu has to open down there — it was anchored
  //    inside .head (position:relative) and opened at the TOP of the panel instead.
  const menu = document.getElementById("cogMenu");
  ok("the cog menu hangs off the panel, not the header", menu.parentElement === panel, menu.parentElement.className || menu.parentElement.id);
  menu.classList.add("open");
  await sleep(30);
  const pr = panel.getBoundingClientRect(), mr = menu.getBoundingClientRect();
  ok("it opens at the panel's bottom", mr.bottom > pr.top + pr.height / 2,
     Math.round(mr.bottom - pr.top) + "px down a " + Math.round(pr.height) + "px panel");
  ok("...flush with the bottom edge", Math.abs(pr.bottom - mr.bottom) < 24, Math.round(pr.bottom - mr.bottom) + "px up from it");
  ok("...and beside the cog, on the right", Math.abs(pr.right - mr.right) < 24, Math.round(pr.right - mr.right) + "px in from it");
  ok("it can't outgrow the screen", mr.height <= window.innerHeight * 0.8, Math.round(mr.height) + "px");
  menu.classList.remove("open");

  // 3. Any page with a text field reveals its bar on pointerdown (hover can't see through an
  //    iframe). Nothing was clearing that latch when the cursor went back to the GAME, because a
  //    click-through window gets no mouseleave — so the bar never retracted.
  const np = WBY.notepad;
  touchWidget(np);
  ok("clicking into a widget reveals its bar", el(np).classList.contains("touched"));
  ok("the page listens for the shell's cursor-away", typeof window.__fireCursorAway === "function");
  if (typeof window.__fireCursorAway === "function") window.__fireCursorAway();
  await sleep(30);
  ok("the bar retracts once the cursor leaves the overlay", !el(np).classList.contains("touched"));
  return out;
})()`;

// ── Suite 10: lifecycle — a closed widget must cost nothing ───────────────────
// Sub's rule: if a widget isn't open it shouldn't be using resources. Hiding used to leave the
// iframe loaded, so a widget opened once kept polling / holding its socket forever — and mining
// kept ANNOUNCING from a box that wasn't on screen, because the one path that backgrounds a group
// tab never told the page it had gone dark.
const LIFECYCLE = `(async () => {
  ${PRELUDE}
  const party = WBY.party, mining = WBY.mining, notepad = WBY.notepad;
  const src = (w) => { const f = document.getElementById("wf-" + w.key); return f ? (f.getAttribute("src") || "") : "(none)"; };
  const loaded = (w) => /\\.html/.test(src(w));

  setWidgetVisible(party, true);
  await sleep(200);
  ok("opening a widget loads its page", loaded(party), src(party).slice(0, 40));

  setWidgetVisible(party, false);
  await sleep(120);
  ok("closing it unloads the page", !loaded(party), src(party).slice(0, 40));
  ok("...and it is no longer armed", !party.armed);

  setWidgetVisible(party, true);
  await sleep(200);
  ok("reopening loads it again", loaded(party), src(party).slice(0, 40));

  // Count the visibility signals the page receives. This is what mining listens to for its
  // "hidden => no sound" rule, so a missed call is an audible bug.
  let hides = 0, shows = 0;
  const oh = mining.onHide, os = mining.onShow;
  mining.onHide = (w) => { hides++; if (oh) oh(w); };
  mining.onShow = (w) => { shows++; if (os) os(w); };
  // (it starts visible in this harness, and re-showing a shown widget correctly signals nothing —
  //  so hide it first, which is also the signal mining relies on to go quiet)
  setWidgetVisible(mining, false);
  await sleep(120);
  ok("hiding a widget tells the page", hides >= 1, hides);
  setWidgetVisible(mining, true);
  await sleep(250);
  ok("showing it tells the page", shows >= 1, shows);

  // Backgrounding it as a group TAB is the case that was silently missed.
  groupWidgets(party, mining);
  await sleep(80);
  ok("the tabbed-away widget is off screen", !shown(mining), "display=" + (document.getElementById("w-mining").style.display || "(shown)"));
  ok("...and the page was TOLD it went dark", hides >= 2, hides + " hide signals");
  ok("...but keeps its iframe (state survives tabbing)", loaded(mining), src(mining).slice(0, 40));

  // Bringing it back to the front must say so again.
  const before = shows;
  const strip = document.getElementById("w-party").querySelector(".wh-tabs")
    || document.getElementById("w-mining").querySelector(".wh-tabs");
  strip.querySelector('.gtab[data-k="mining"]').click();
  await sleep(80);
  ok("fronting the tab tells the page it is visible again", shows > before, shows);
  mining.onHide = oh; mining.onShow = os;

  // An ARMED widget (mining waiting to auto-show) must stay loaded even while hidden.
  detachFromGroup(WBY[GROUPS[0] ? GROUPS[0].active : "mining"]);
  mining.keepLoaded = true;
  setWidgetVisible(mining, false);
  await sleep(120);
  ok("an armed widget stays loaded while hidden", loaded(mining), src(mining).slice(0, 40));
  mining.keepLoaded = false;
  setWidgetVisible(mining, false);
  await sleep(120);
  ok("...and unloads once it is no longer armed", !loaded(mining), src(mining).slice(0, 40));
  return out;
})()`;

// ── Suite 11: per-widget angle ────────────────────────────────────────────────
// Sub's report: "people can't change the angle of the widget, and the newer ones don't even have
// the option." Both were real. The angle was written to --wangle inside the `scaled` branch of
// applyFrame() only — so when the last scaled widget (Mining) became a box in 0.1.34, the two
// sliders that existed moved a value nothing read, and the seven widgets added since never got a
// control at all. These assertions are per-widget on purpose: a fix that only works for the
// Blueprint panel is the bug again.
//
// Two widgets opt OUT (noAngle, Sub 2026-07-29): Web Page hosts somebody else's site, and the
// Infographic Viewer shows dense reference art — tilting either only costs legibility. They must
// stay flat AND show no control, which is what TILTING/FLAT below separate.
const ANGLE = `(async () => {
  ${PRELUDE}
  for (const w of WIDGETS) setWidgetVisible(w, true);
  await sleep(1200);                       // iframes must LOAD before their settings rows exist
  for (const w of WIDGETS) probeSettings(w);
  const tf = (w) => getComputedStyle(el(w)).transform;
  const TILTING = WIDGETS.filter((w) => !w.noAngle);
  const FLAT = WIDGETS.filter((w) => w.noAngle);

  // ── it applies at all ───────────────────────────────────────────────────────
  const deaf = [], flat0 = new Map();
  for (const w of WIDGETS) flat0.set(w.key, tf(w));
  for (const w of TILTING) {
    setWidgetAngle(w, 20);
    const t = tf(w);
    if (cs(w, "--wangle").trim() !== "20deg") deaf.push(w.key + " var=" + cs(w, "--wangle"));
    else if (t === "none" || t === flat0.get(w.key)) deaf.push(w.key + " transform unchanged (" + t + ")");
  }
  ok("every tilting widget tilts when its angle changes", deaf.length === 0, deaf.slice(0, 4).join(" | "));

  const neg = [];
  for (const w of TILTING) { setWidgetAngle(w, -20); if (cs(w, "--wangle").trim() !== "-20deg") neg.push(w.key); }
  ok("...in both directions", neg.length === 0, neg.join(","));

  // The opt-outs must IGNORE the angle, not merely lack a slider — a stale saved value or a
  // tilted group would otherwise leave them crooked with no way back.
  const stuck = [];
  for (const w of FLAT) {
    setWidgetAngle(w, 20);
    if (cs(w, "--wangle").trim() !== "0deg") stuck.push(w.key + " var=" + cs(w, "--wangle"));
  }
  ok("a no-angle widget stays flat when something tries to tilt it", stuck.length === 0, stuck.join(",") || FLAT.map(w => w.key).join(","));
  ok("angle is clamped to the slider range", setWidgetAngle(WBY.notepad, 400) === 35 && setWidgetAngle(WBY.notepad, -400) === -35);
  ok("a junk angle reads as flat, not NaNdeg", setWidgetAngle(WBY.notepad, "banana") === 0 && cs(WBY.notepad, "--wangle") === "0deg", cs(WBY.notepad, "--wangle"));

  // ── every widget offers a way to change it ──────────────────────────────────
  const noCtl = [], dead = [], strayCtl = [];
  for (const w of FLAT) {
    if (angleControls(w).filter(c => c.input).length) strayCtl.push(w.key);
  }
  ok("...and offers no angle control at all", strayCtl.length === 0, strayCtl.join(",") || FLAT.map(w => w.key).join(","));
  for (const w of TILTING) {
    const ctls = angleControls(w).filter(c => c.input);
    if (!ctls.length) { noCtl.push(w.key); continue; }
    // and the control is wired: driving the input must move the widget
    const input = ctls[0].input;
    input.value = "12";
    input.dispatchEvent(new (input.ownerDocument.defaultView.Event)("input", { bubbles: true }));
    await sleep(20);
    if (cs(w, "--wangle").trim() !== "12deg") dead.push(w.key + " -> " + cs(w, "--wangle"));
  }
  ok("every tilting widget exposes an angle control", noCtl.length === 0, noCtl.join(",") || TILTING.map(w => w.key).join(","));
  ok("...and driving that control tilts the widget", dead.length === 0, dead.slice(0, 4).join(" | "));

  // every control on a widget shows the SAME number (bespoke slider + injected row + popover)
  const desync = [];
  for (const w of TILTING) {
    setWidgetAngle(w, -7);
    for (const c of angleControls(w)) if (c.input && Number(c.input.value) !== -7) desync.push(w.key);
  }
  ok("all of a widget's angle controls agree", desync.length === 0, [...new Set(desync)].join(","));

  // ── it survives a restart ───────────────────────────────────────────────────
  const saved = [];
  window.overlayApi = Object.assign({}, window.overlayApi, {
    saveWidget: (id, l) => saved.push([id, JSON.parse(JSON.stringify(l))]),
  });
  setWidgetAngle(WBY.notepad, -13); persistLayout(WBY.notepad);
  const rec = saved.filter(s => s[0] === "notepad").pop();
  ok("a box widget's angle is persisted", rec && rec[1].angle === -13, rec ? JSON.stringify(rec[1]) : "nothing saved");

  // ── a stack shares one angle ────────────────────────────────────────────────
  while (GROUPS.length) detachFromGroup(WBY[GROUPS[0].active]);
  setWidgetAngle(WBY.party, 15);
  groupWidgets(WBY.notepad, WBY.party);   // notepad dropped onto party
  await sleep(60);
  const g = GROUPS[0];
  ok("a new group takes the host widget's angle", g && g.angle === 15, g && g.angle);
  ok("both members render the group's angle",
     cs(WBY.party, "--wangle") === "15deg" && cs(WBY.notepad, "--wangle") === "15deg",
     cs(WBY.party, "--wangle") + " / " + cs(WBY.notepad, "--wangle"));
  saved.length = 0;
  setWidgetAngle(WBY.notepad, -9); persistLayout(WBY.notepad);
  ok("tilting one tab tilts the whole stack",
     GROUPS[0].angle === -9 && cs(WBY.party, "--wangle") === "-9deg", cs(WBY.party, "--wangle"));
  ok("a stacked widget saves its angle to the GROUP", saved.some(s => s[0] === "__groups"), saved.map(s => s[0]).join(","));
  detachFromGroup(WBY.notepad);
  await sleep(40);
  ok("popping a tab out keeps the tilt it had", cs(WBY.notepad, "--wangle") === "-9deg", cs(WBY.notepad, "--wangle"));

  // ── reset puts it back flat ─────────────────────────────────────────────────
  resetWidget(WBY.notepad);
  ok("reset flattens the widget", cs(WBY.notepad, "--wangle") === "0deg", cs(WBY.notepad, "--wangle"));
  ok("...and its control follows", angleControls(WBY.notepad).every(c => !c.input || Number(c.input.value) === 0));

  while (GROUPS.length) detachFromGroup(WBY[GROUPS[0].active]);
  for (const w of WIDGETS) resetWidget(w);
  return out;
})()`;

async function run(label, script, preload, query) {
  const web = preload ? { preload, contextIsolation: false } : {};
  const win = new BrowserWindow({ show: false, width: 1920, height: 1080, webPreferences: web });
  // A widget that logs an error or 404s an asset is broken even when every assertion passes -
  // a missing image just renders as nothing. Capture both and fail the run on them.
  const noise = [];
  win.webContents.on("console-message", (...a) => {
    const e = a[0], lvl = typeof e === "object" ? e.level : a[1], msg = typeof e === "object" ? e.message : a[2];
    if ((lvl === "error" || lvl >= 2) && !/Security Warning/.test(String(msg))) noise.push("console: " + String(msg).slice(0, 120));
  });
  // The third-party emote providers answer 404 for a channel that simply isn't registered with
  // them, which is the common case and not a fault - don't fail a run over it.
  // The unlock-pop suite points an <img> at a URL that must 404 — that IS the assertion (no
  // capture for this item yet → fall back to the render). Named so it can't be mistaken for a real
  // missing asset.
  const EXPECTED_404 = /(^|\/\/)(api\.frankerfacez\.com|7tv\.io|api\.betterttv\.net)\/|deliberate-404-for-test\.webp/;
  win.webContents.session.webRequest.onCompleted({ urls: ["*://*/*"] }, (d) => {
    if (d.statusCode < 400) return;
    if (d.statusCode === 404 && EXPECTED_404.test(d.url)) return;
    noise.push("HTTP " + d.statusCode + " " + d.url.replace(/^https?:\/\//, "").slice(0, 70));
  });
  try {
    await win.loadURL(query ? URL + "&" + query : URL);
    const res = await win.webContents.executeJavaScript(script);
    let fails = 0;
    console.log(`\n${label}`);
    for (const r of res) {
      if (!r.pass) fails++;
      console.log((r.pass ? "  ok   " : "  FAIL ") + r.name + (r.detail ? "   [" + r.detail + "]" : ""));
    }
    const uniq = [...new Set(noise)];
    if (uniq.length) { fails++; console.log("  FAIL console/network clean   [" + uniq.slice(0, 4).join(" | ") + "]"); }
    else console.log("  ok   console/network clean");
    console.log(`  ${res.length + 1 - fails}/${res.length + 1} passed` + (fails ? `  <<< ${fails} FAILED` : ""));
    return fails;
  } finally { win.destroy(); }
}

// The summoned cog / open hub times itself out once the GAME has focus, because that's when it
// gets forgotten — and a forgotten hub holds setModal(true), so the canvas keeps eating clicks.
// Driven with ?coghide=250 so the suite doesn't sit here for half a minute.
const COGHIDE = `(async () => {
  ${PRELUDE}
  const gc = document.getElementById("globalCog"), hub = document.getElementById("hub");
  const up = () => gc.classList.contains("show") || hub.classList.contains("open");

  gc.classList.add("show");
  await sleep(60);
  ok("summoning the cog asks for foreground tracking", window.__foregroundWanted === true, window.__foregroundWanted);

  // Game NOT in front: it must stay put no matter how long we wait.
  window.__fireGameFocus?.(false);
  await sleep(500);
  ok("stays up while the game is not focused", up());

  // Game in front: gone after the (shortened) delay.
  window.__fireGameFocus?.(true);
  await sleep(500);
  ok("hides once the game has had focus", !up());
  ok("releases foreground tracking when it hides", window.__foregroundWanted === false, window.__foregroundWanted);

  // The case Sub actually hit: hub OPEN, which the 10s fade deliberately never closes.
  gc.classList.add("show"); gc.click();
  await sleep(60);
  ok("hub opens", hub.classList.contains("open"));
  window.__fireGameFocus?.(true);
  await sleep(500);
  ok("an OPEN hub closes too", !hub.classList.contains("open") && !up());

  // Hovering it means you're using it — the clock must not run it out from under you.
  gc.classList.add("show"); gc.click();
  await sleep(60);
  gc.dispatchEvent(new MouseEvent("mouseenter"));
  window.__fireGameFocus?.(true);
  await sleep(600);
  ok("hovering keeps it open indefinitely", hub.classList.contains("open"));
  gc.dispatchEvent(new MouseEvent("mouseleave"));
  await sleep(500);
  ok("closes once the pointer leaves", !hub.classList.contains("open"));
  return out;
})()`;

// An unlocked blueprint must show the FABRICATOR CAPTURE, not the clay render. The render exists
// for nearly every item but is a grey untextured mesh, and items that reuse a game model share one
// byte-identical render — all three Scraper Modules do — so the render can't even identify what you
// unlocked. The capture 404s until someone has captured that item, hence the fallback chain.
// Local URLs stand in for the two endpoints so the suite doesn't depend on the network.
const BPPOP = `(async () => {
  ${PRELUDE}
  const GOOD = "tape-tl.webp", GOOD2 = "anvil-bolt-tl.webp", BAD = "deliberate-404-for-test.webp";
  const thumb = document.querySelector("#bpPop .bp-pop-thumb"), img = document.getElementById("bpPopImg");
  const src = () => (img.getAttribute("src") || "");
  // maybeBpPop dedupes on the receipt time, so every call needs a distinct one — and a fresh one,
  // since it drops anything older than 2 min. Counting backwards a second at a time keeps both true.
  let n = 0;
  const pop = (o) => { img.onerror = null; maybeBpPop({ name: "T", at: new Date(Date.now() - (n++ * 1000)).toISOString(), ...o }); };

  pop({ image: GOOD, imageFallback: GOOD2 });
  await sleep(200);
  ok("prefers the fabricator capture over the render", src().endsWith(GOOD), src());
  ok("...and shows the thumb", !thumb.classList.contains("noimg"));

  // No capture for this item yet (404) — must land on the render rather than a blank tile.
  pop({ image: BAD, imageFallback: GOOD2 });
  await sleep(400);
  ok("falls back to the render when no capture exists", src().endsWith(GOOD2), src());
  ok("...still shows a thumb", !thumb.classList.contains("noimg"));

  // Neither resolves — glyph, and no infinite retry loop between the two.
  pop({ image: BAD, imageFallback: BAD });
  await sleep(500);
  ok("falls through to the glyph when both fail", thumb.classList.contains("noimg"));

  // Unresolvable name: no UUID, so neither URL exists.
  pop({ image: null, imageFallback: null });
  await sleep(150);
  ok("no image at all = glyph", thumb.classList.contains("noimg"));

  // Older payload shape (render only) must still work.
  pop({ image: null, imageFallback: GOOD });
  await sleep(200);
  ok("render-only payload still renders", src().endsWith(GOOD), src());
  return out;
})()`;

app.disableHardwareAcceleration();
// Suites run one window at a time, and destroying the last open window would otherwise trigger
// Electron's default quit-on-window-all-closed and kill the run before the next suite loads.
app.on("window-all-closed", () => {});
app.whenReady().then(async () => {
  let fails = 0;
  try {
    fails += await run("widget grouping", GROUPING, null);
    fails += await run("pair merges (brute force)", PAIRS, null);
    fails += await run("title-bar chrome", CHROME, null);
    fails += await run("controls visible + reachable", REACH, null);
    fails += await run("sweeps: themes / sizes / text / stacks", SWEEPS, null);
    fails += await run("dragging + reset", DRAG, null);
    fails += await run("page headers", HEADERS, null);
    fails += await run("layout restore", RESTORE, path.join(__dirname, "widget-dom-stub-preload.cjs"));
    fails += await run("chrome anchoring + latches", ANCHOR, path.join(__dirname, "widget-dom-stub-preload.cjs"));
    fails += await run("lifecycle: closed = idle", LIFECYCLE, null);
    fails += await run("per-widget angle", ANGLE, null);
    fails += await run("cog auto-hide on game focus", COGHIDE,
      path.join(__dirname, "widget-dom-stub-preload.cjs"), "coghide=250");
    fails += await run("unlock pop: capture before render", BPPOP, null);
  } catch (e) {
    console.error(`\nharness error: ${e && e.message}`);
    console.error(`is the sidecar running? \`npm run overlay\` should be listening on :${PORT}`);
    fails = 1;
  }
  console.log(fails ? `\nFAILED (${fails})` : "\nall widget DOM tests passed");
  process.exitCode = fails ? 1 : 0;
  app.quit();
});

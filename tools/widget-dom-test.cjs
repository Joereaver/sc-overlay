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

  // The cog must actually DO something — a dead control that merely exists is the bug we keep hitting.
  const w0 = WBY.party, e0 = document.getElementById("w-party");
  e0.classList.add("touched");
  e0.querySelector(".wh-cog").click(); await sleep(20);
  const opened = e0.classList.contains("cfgopen") && visibleArea(e0.querySelector(".wcfg")) > 400;
  ok("clicking the cog actually opens a visible popover", opened,
     "cfgopen=" + e0.classList.contains("cfgopen") + " area=" + Math.round(visibleArea(e0.querySelector(".wcfg"))) + " clipper=" + lastClipper);
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

async function run(label, script, preload) {
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
  const EXPECTED_404 = /(^|\/\/)(api\.frankerfacez\.com|7tv\.io|api\.betterttv\.net)\//;
  win.webContents.session.webRequest.onCompleted({ urls: ["*://*/*"] }, (d) => {
    if (d.statusCode < 400) return;
    if (d.statusCode === 404 && EXPECTED_404.test(d.url)) return;
    noise.push("HTTP " + d.statusCode + " " + d.url.replace(/^https?:\/\//, "").slice(0, 70));
  });
  try {
    await win.loadURL(URL);
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
    fails += await run("layout restore", RESTORE, path.join(__dirname, "widget-dom-stub-preload.cjs"));
  } catch (e) {
    console.error(`\nharness error: ${e && e.message}`);
    console.error(`is the sidecar running? \`npm run overlay\` should be listening on :${PORT}`);
    fails = 1;
  }
  console.log(fails ? `\nFAILED (${fails})` : "\nall widget DOM tests passed");
  process.exitCode = fails ? 1 : 0;
  app.quit();
});

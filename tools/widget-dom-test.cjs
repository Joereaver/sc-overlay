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
  const el = (w) => document.getElementById("w-" + w.key);
  const shown = (w) => el(w).style.display !== "none";
  const cs = (w, v) => el(w).style.getPropertyValue(v);
  await sleep(900); // let the async layout loader settle
  // A hidden window never composites, so CSS transitions don't advance and a mid-slide transform
  // would be read as "still parked". Assert on settled geometry instead.
  const noAnim = document.createElement("style");
  noAnim.textContent = ".whead{transition:none !important}";
  document.head.appendChild(noAnim);
`;

// ── Suite 1: grouping behaviour ────────────────────────────────────────────────
const GROUPING = `(async () => {
  ${PRELUDE}
  const saved = [];
  window.overlayApi = Object.assign({}, window.overlayApi, {
    saveWidget: (id, l) => saved.push([id, JSON.parse(JSON.stringify(l))]),
  });

  ok("registry has 8 widgets", typeof WIDGETS !== "undefined" && WIDGETS.length === 8, typeof WIDGETS !== "undefined" ? WIDGETS.length : "unreachable");
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
  ok("scaled widget drops .scaled while grouped", !el(mining).classList.contains("scaled"));
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
  ok("scaled widget regains .scaled", el(mining).classList.contains("scaled"));

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

  const frameBox = (w) => document.getElementById("wf-" + w.key).getBoundingClientRect();
  // Snapshot each widget's healthy standalone frame size to compare against after a merge cycle.
  const baseline = {};
  for (const w of WIDGETS) { const r = frameBox(w); baseline[w.key] = [Math.round(r.width), Math.round(r.height)]; }

  const broken = [], groupBad = [];
  for (let i = 0; i < WIDGETS.length; i++) {
    for (let j = i + 1; j < WIDGETS.length; j++) {
      const a = WIDGETS[i], b = WIDGETS[j];
      groupWidgets(a, b);
      const g = GROUPS[0];
      // While grouped: one box, exactly one member on screen, and it must have real size.
      const vis = g ? g.members.filter(k => document.getElementById("w-" + k).style.display !== "none") : [];
      const fr = frameBox(WBY[g ? g.active : a.key]);
      if (!g || g.members.length !== 2 || vis.length !== 1 || fr.width < 20 || fr.height < 20) {
        groupBad.push(a.key + "+" + b.key + " (members=" + (g ? g.members.length : 0) + " visible=" + vis.length +
                      " frame=" + Math.round(fr.width) + "x" + Math.round(fr.height) + ")");
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
  ok("no pair leaves a widget degenerate or drifting", broken.length === 0,
     broken.length + " broken: " + broken.slice(0, 4).join(" | "));
  // A self-sizing widget is the one that CAN drift, so hold it to its natural size specifically.
  await sleep(400); // measure() runs on a 150ms timer
  const mr0 = frameBox(WBY.mining);
  ok("self-sizing widget returns to its natural size after all that",
     Math.abs(Math.round(mr0.width) - baseline.mining[0]) <= 4 && Math.abs(Math.round(mr0.height) - baseline.mining[1]) <= 4,
     Math.round(mr0.width) + "x" + Math.round(mr0.height) + " want " + baseline.mining.join("x"));

  // The specific pair Sub reported, checked end to end.
  groupWidgets(WBY.mining, WBY.twitchChat);
  await sleep(60);
  detachFromGroup(WBY.mining);
  await sleep(200);
  const mr = frameBox(WBY.mining);
  ok("Sub's case: mining is whole after leaving a Twitch-chat stack",
     Math.abs(Math.round(mr.width) - baseline.mining[0]) <= 4 && Math.abs(Math.round(mr.height) - baseline.mining[1]) <= 4,
     Math.round(mr.width) + "x" + Math.round(mr.height) + " want " + baseline.mining.join("x"));
  ok("mining exposes the remeasure hook grouping needs",
     typeof document.getElementById("wf-mining").contentWindow.__widgetRemeasure === "function");
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
  ok("bar carries title + move/reset/settings/close",
     bar.querySelector(".wh-title") && bar.querySelectorAll(".wh-btn").length === 4,
     bar.querySelector(".wh-title") && bar.querySelector(".wh-title").textContent);

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
  el(w).classList.add("moving");
  ok("bar hidden in arrange mode", getComputedStyle(hood).display === "none", getComputedStyle(hood).display);
  el(w).classList.remove("moving");

  // ── manufacturer trinket rides the bar ──────────────────────────────────────
  const mw = WBY.mining, mbar = el(mw).querySelector(".whead");
  const flair = mbar.querySelector(".wh-flair");
  ok("flair widget is marked", el(mw).classList.contains("flair"));
  ok("flair element on the bar", !!flair);
  ok("no flair on a non-flair widget", !el(WBY.notepad).querySelector(".wh-flair"));
  const root = document.documentElement, theme0 = root.getAttribute("data-theme");
  root.setAttribute("data-theme", "mobiglas");
  ok("no trinket on a theme that has none", getComputedStyle(flair).display === "none", getComputedStyle(flair).display);
  root.setAttribute("data-theme", "drake");
  ok("Drake shows its tape", getComputedStyle(flair).display === "block" && /tape/.test(getComputedStyle(flair).backgroundImage),
     getComputedStyle(flair).backgroundImage.slice(0, 60));
  ok("trinket replaces the diamond", getComputedStyle(mbar.querySelector(".dia")).display === "none");
  // Must fit inside the bar, or it would peek out above a parked bar (the hood clips at the bar).
  el(mw).classList.add("touched");
  const fr = flair.getBoundingClientRect(), br = mbar.getBoundingClientRect();
  ok("trinket fits inside the bar", fr.height <= br.height + 0.5 && fr.top >= br.top - 0.5,
     "flair h=" + fr.height.toFixed(1) + " bar h=" + br.height.toFixed(1));
  el(mw).classList.remove("touched");
  root.setAttribute("data-theme", "argo");
  ok("Argo shows its cog", /cog-argo/.test(getComputedStyle(flair).backgroundImage));

  // ── per-widget settings cog ────────────────────────────────────────────────
  // It opens THAT widget's own panel, so it only exists where the page exposes one. It must never
  // quietly stand in for global settings (those live on the global cog and the tray).
  for (let i = 0; i < 40 && !el(mw).classList.contains("has-settings"); i++) await sleep(50); // iframe load
  ok("Mining exposes its own settings", typeof document.getElementById("wf-mining").contentWindow.__widgetSettings === "function");
  ok("Mining's cog is shown", el(mw).classList.contains("has-settings") && getComputedStyle(mbar.querySelector(".wh-cog")).display !== "none");
  const np = WBY.notepad;
  ok("a widget with no settings hides its cog",
     !el(np).classList.contains("has-settings") && getComputedStyle(el(np).querySelector(".wh-cog")).display === "none",
     getComputedStyle(el(np).querySelector(".wh-cog")).display);

  // ── the Blueprint panel carries the same bar ───────────────────────────────
  const bp = document.getElementById("panel");
  const bpbar = bp.querySelector(".whood > .whead");
  ok("Blueprint panel has the bar too", !!bpbar);
  ok("Blueprint bar has all four controls", bpbar && bpbar.querySelectorAll(".wh-btn").length === 4,
     bpbar && bpbar.querySelectorAll(".wh-btn").length);
  ok("Blueprint's old top-right chrome is gone", !!document.getElementById("grip") && !!document.getElementById("grip").closest(".whead"));
  // NB the panel carries a 3D perspective tilt, so its projected rect and a child's don't share
  // an edge — assert the LAYOUT invariant (the hood is pinned to the panel's bottom) instead.
  const bphood = bp.querySelector(".whood");
  ok("Blueprint bar hangs below the panel",
     bphood && Math.abs(parseFloat(getComputedStyle(bphood).top) - bp.clientHeight) < 1.5,
     bphood && (getComputedStyle(bphood).top + " vs panel padding-box h " + bp.clientHeight));
  if (theme0) root.setAttribute("data-theme", theme0); else root.removeAttribute("data-theme");

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
  try {
    await win.loadURL(URL);
    const res = await win.webContents.executeJavaScript(script);
    let fails = 0;
    console.log(`\n${label}`);
    for (const r of res) {
      if (!r.pass) fails++;
      console.log((r.pass ? "  ok   " : "  FAIL ") + r.name + (r.detail ? "   [" + r.detail + "]" : ""));
    }
    console.log(`  ${res.length - fails}/${res.length} passed` + (fails ? `  <<< ${fails} FAILED` : ""));
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

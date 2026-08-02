// Electron shell for SC Overlay — a transparent, always-on-top,
// click-through in-game HUD plus a system tray, wrapping the existing local server.
//
// The server (src/overlay-server.ts) is unchanged: Electron just manages its
// lifecycle and points a frameless transparent BrowserWindow at the HUD it serves
// (http://localhost:8778/missions.html). OBS browser-source mode still works in
// parallel — the server serves both.
//
// Click-through is ON by default so the overlay never eats clicks meant for the
// game; toggle "Interactive" (tray or Ctrl+Alt+B) to click the picker/buttons.
// Requires SC in BORDERLESS WINDOWED — overlays can't draw over exclusive fullscreen.

const { app, BrowserWindow, Tray, Menu, nativeImage, screen, shell, ipcMain, dialog } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const { autoUpdater } = require("electron-updater");
// Hotkeys go through a low-level keyboard hook (see hotkeys.cjs) instead of Electron's
// globalShortcut, so they fire while Star Citizen has focus (RegisterHotKey does not).
const hotkeys = require("./hotkeys.cjs");
const { startFabCapture } = require("./capture.cjs");
const foreground = require("./foreground.cjs");

// GPU hardware acceleration is OFF by default: the HUD is a transparent, always-on-top
// window composited over a fullscreen Vulkan game (Star Citizen), and GPU-compositing it
// crashes AMD drivers (device-lost / TDR — overlay ON = CTD, OFF = fine). Software
// rendering is safe for a text HUD. Users with GPU headroom can turn it back on in
// settings (SC is CPU-bound, so this trades a little CPU either way). Read from the
// server's config.json here because it must run BEFORE app "ready".
function hwAccelEnabled() {
  try {
    const p = path.join(process.env.APPDATA || process.env.HOME || ".", "sc-blueprint-tracker", "config.json");
    return JSON.parse(fs.readFileSync(p, "utf8")).hwAccel === true;
  } catch {
    return false; // default OFF (crash-safe)
  }
}
// AMD compatibility mode (opt-in, restart-required). Even with hardware acceleration off, the
// transparent HUD is still GPU-COMPOSITED by Windows via DirectComposition + Multiplane Overlay
// (MPO) over the game's Vulkan swapchain — disableHardwareAcceleration stops GPU *rendering* of
// the page, not GPU *compositing* of the window. That DComp/MPO surface presenting over an AMD
// Vulkan present is the device-lost/TDR crash. This mode forces the window fully off the GPU
// compositing path (software compositing, no occlusion polling) AND loads the lite HUD skin
// (see AMD_COMPAT in createOverlay). See the AMD-tester crash log: STATUS_CRYENGINE_GPU_CRASH.
function amdCompatEnabled() {
  try {
    const p = path.join(process.env.APPDATA || process.env.HOME || ".", "sc-blueprint-tracker", "config.json");
    return JSON.parse(fs.readFileSync(p, "utf8")).amdCompat === true;
  } catch {
    return false;
  }
}
const AMD_COMPAT = amdCompatEnabled();
if (AMD_COMPAT) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
} else if (!hwAccelEnabled()) {
  app.disableHardwareAcceleration();
}

// Master overlay switch, persisted in its OWN file (the sidecar owns config.json and
// rewrites it on unrelated changes, which would clobber a flag stored there). Default ON.
function overlayStateFile() {
  return path.join(process.env.APPDATA || process.env.HOME || ".", "sc-blueprint-tracker", "overlay-state.json");
}
function readOverlayEnabled() {
  try {
    return JSON.parse(fs.readFileSync(overlayStateFile(), "utf8")).enabled !== false;
  } catch {
    return true; // default ON
  }
}
function writeOverlayEnabled(on) {
  try {
    fs.mkdirSync(path.dirname(overlayStateFile()), { recursive: true });
    fs.writeFileSync(overlayStateFile(), JSON.stringify({ enabled: on }));
  } catch (e) {
    console.error("[electron] overlay-state write failed", String(e));
  }
}

const ROOT = path.join(__dirname, "..");
// The app version from package.json (works packaged + in dev). app.getVersion() returns
// Electron's own version when launched on a script rather than a packaged app, so read the
// manifest directly and fall back only if that fails.
const APP_VERSION = (() => {
  try { const v = require(path.join(ROOT, "package.json")).version; if (v) return v; } catch { /* fall through */ }
  return app.getVersion();
})();
const PORT = 8778;
const HUD_URL = `http://localhost:${PORT}/missions.html`;
const CONFIG_URL = `http://localhost:${PORT}/config.html`;
const SETUP_URL = `http://localhost:${PORT}/setup.html`;

let server = null;
let overlay = null;
let configWin = null;
let setupWin = null;
let overlayLoaded = false; // canvas page has finished loading (its IPC listeners exist)
let tray = null;
let hovering = false; // pointer is over the HUD (reported by the page)
let holdInteract = false; // true only while the interact-hold hotkey (default F) is held down
let holdMode = false; // opt-in: when true, interaction REQUIRES holding the interact key (default off)
let notepadEditing = false; // notepad "typing mode": overlay holds keyboard focus + the interact key is suspended so it types as a letter
let notepadFocusPending = false; // defer focusing the note field until a held interact key is released (avoids a stray character)
let moveMode = false; // arrange mode: show the drag banner/handles (VISUAL only — interactivity stays hover-based)
let modalOpen = false; // a HUD modal (what's-new card / hub) is up — stay hover-interactive even if locked
let dragging = false; // an active drag/resize gesture on THIS window — force it interactive so it can't drop
// Mining Assistant — now folded INTO the overlay canvas as an iframe widget (no separate
// window). The shell owns its VISIBILITY (so the tray, hotkey, hub toggle, and auto-show stay
// one source of truth) and drives it into the overlay renderer; the renderer owns the DOM +
// per-widget layout, drag, and cursor hit-testing (one window → no cross-window z-order bugs).
let miningVisible = false; // is the in-canvas mining widget currently shown
let notepadVisible = false; // is the in-canvas notepad widget currently shown
let twitchChatVisible = false; // is the in-canvas Twitch Chat widget currently shown
let scFeedVisible = false; // is the in-canvas SC Feed notifier armed (it only SHOWS when there's news)
// Blueprint-unlock notifier. Defaults ON because it REPLACED the toast that used to be pinned
// inside the Blueprint panel — leaving it off by default would silently remove a notification
// people already had.
let unlockAlertVisible = true;
let partyVisible = false; // is the in-canvas Party split widget currently shown
let battagliaVisible = false; // is the in-canvas Battaglia grind tracker currently shown
// Settings as a canvas WIDGET. Named ...Widget... throughout to keep it distinct from
// `configWin`, the standalone settings WINDOW — both exist, same page, two host modes.
let configWidgetVisible = false;
let webViewVisible = false; // is the in-canvas Web Page widget currently shown
let bindingChartVisible = false; // is the in-canvas Binding Chart WIDGET shown (not the full-screen overlay)
let miningArm = false;      // load the mining iframe hidden at startup (auto-show waiting to pop)
let miningAutoSuppress = 0; // auto-show is suppressed until this timestamp (set on a manual hide)
let overlayEnabled = true; // master switch — false = HUD window destroyed, tracking still runs
let manualCheck = false; // true while a tray-triggered update check is in flight (gates dialogs)
// Background update download in flight: { version, percent, bps } — drives the live
// progress line in the tray menu + the tray tooltip. null when idle.
let updateDownload = null;

// ── the Web Page widget's actual web page ───────────────────────────────────
// It used to be an iframe, which meant it could only show sites willing to be framed — and the
// site a Star Citizen player most wants pinned over the game, robertsspaceindustries.com, is not
// one of them. Stripping X-Frame-Options isn't enough either: measured 2026-07-29, RSI delivers
// 710KB of HTML into a frame and then renders NOTHING (it busts frames client-side), while the
// same URL top-level in the same session paints the real site.
//
// So the page lives in a WebContentsView owned by main, where it IS top-level. The widget's
// chrome (URL bar, quick chips, header, resize handle) stays in the renderer, and the renderer
// tells us the rectangle to fill — a hole it leaves in its own layout.
//
// A view is an axis-aligned native rectangle painted ABOVE all page content, which is why this
// widget doesn't tilt (noAngle in the registry) and why the view must be HIDDEN whenever
// something needs to draw over it: arrange mode, an open modal, or a group tab-switch.
let webView = null;
let webViewBounds = { x: 0, y: 0, width: 0, height: 0 };
let webViewWanted = false;   // the renderer wants it visible
let webViewMasked = false;   // ...but something is drawing over it right now
let webViewPainted = false;  // what the two above actually resolved to
let webViewHover = false;    // is the cursor over the view right now

function ensureWebView() {
  if (webView || !overlay) return webView;
  const { WebContentsView } = require("electron");
  webView = new WebContentsView({
    webPreferences: {
      // Someone else's website: no preload, no node, and its own jar so third-party cookies
      // never mix with the app's session.
      partition: "persist:webwidget",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Target=_blank and window.open must not spawn a second frameless always-on-top window over
  // the game — send those to the real browser instead.
  webView.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  // Keep the widget's chrome honest about what it's showing.
  const report = () => {
    try {
      overlay?.webContents.send("webview:state", {
        url: webView.webContents.getURL(),
        title: webView.webContents.getTitle(),
        loading: webView.webContents.isLoading(),
        canGoBack: webView.webContents.navigationHistory.canGoBack(),
      });
    } catch { /* overlay went away */ }
  };
  webView.webContents.on("did-stop-loading", report);
  webView.webContents.on("did-navigate", report);
  webView.webContents.on("did-navigate-in-page", report);
  webView.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;
    try { overlay?.webContents.send("webview:state", { url, failed: `${desc} (${code})` }); } catch { /* gone */ }
  });
  overlay.contentView.addChildView(webView);
  applyWebViewBounds();
  return webView;
}

/** Painted only when the renderer wants it AND nothing is drawing over it. Zero-size bounds is
 *  how a view is hidden — setVisible exists, but a 0×0 rect also stops it eating the cursor. */
function applyWebViewBounds() {
  if (!webView) return;
  const on = webViewWanted && !webViewMasked && overlayEnabled;
  webView.setVisible(on);
  webView.setBounds(on ? webViewBounds : { x: 0, y: 0, width: 0, height: 0 });
  // Echo what we actually did. Nothing inside a hidden view can report this — it keeps its last
  // size and visibility state — so the shell is the only honest source, and the widget needs it
  // to know whether the page it thinks it's showing is on screen at all.
  webViewPainted = on;
  try {
    overlay?.webContents.send("webview:painted", { painted: on, wanted: webViewWanted, masked: webViewMasked, bounds: webViewBounds });
  } catch { /* overlay went away */ }
}

function destroyWebView() {
  if (!webView) return;
  try { overlay?.contentView.removeChildView(webView); } catch { /* window already gone */ }
  try { webView.webContents.close(); } catch { /* already closed */ }
  webView = null;
}

/** Arrange mode, a modal, or the overlay being switched off must all cover the view. */
function maskWebView(on) {
  webViewMasked = !!on;
  applyWebViewBounds();
}

// ── server lifecycle ────────────────────────────────────────────────────────
// The sidecar's console, kept on disk. It used to be spawned with stdio:"ignore", so when it
// died it died silently: the app stayed up, every already-loaded widget kept rendering, and the
// first sign of trouble was a fetch failing minutes later ("couldn't reach the overlay service").
// Truncated per launch — this is for diagnosing the session you're in, not history.
const SIDECAR_LOG = path.join(process.env.APPDATA || process.env.HOME || ".", "sc-blueprint-tracker", "sidecar.log");

let sidecarLogOpened = false;

function sidecarLogStream() {
  try {
    fs.mkdirSync(path.dirname(SIDECAR_LOG), { recursive: true });
    // Truncate once per APP launch, then append. A respawn must not erase the crash it is
    // recovering from — that stack is the entire reason this file exists.
    const fd = fs.openSync(SIDECAR_LOG, sidecarLogOpened ? "a" : "w");
    sidecarLogOpened = true;
    return fd;
  } catch (e) {
    console.error("[electron] could not open the sidecar log:", String(e));
    return "ignore";
  }
}

/** Write a line from the SHELL into the sidecar's log, so a crash and its restart read as one
 *  timeline instead of being split across two places the user can't see. */
function noteInSidecarLog(line) {
  try { fs.appendFileSync(SIDECAR_LOG, `\n[electron ${new Date().toISOString()}] ${line}\n`); } catch { /* best effort */ }
}

// Restart backoff. A sidecar that crashes on startup (a bad dataset, a port fight) must not be
// respawned in a tight loop — back off, and give up loudly rather than churning forever.
let serverRestarts = 0;
let serverRestartTimer = null;

function startServer() {
  const out = sidecarLogStream();
  const stdio = out === "ignore" ? "ignore" : ["ignore", out, out];
  if (app.isPackaged) {
    // Prod: the bun-compiled server binary shipped as an extraResource (no Node/tsx
    // on the user's machine). cwd = its dir so assetDir finds overlay/ + data/.
    const exe = path.join(process.resourcesPath, "server", "sc-overlay-server.exe");
    // 🔑 `windowsHide` is NOT optional here. The bun-compiled sidecar is a CONSOLE-subsystem
    // executable, and this app is a GUI process with no console of its own — so without
    // CREATE_NO_WINDOW, Windows hands the child a brand new console, which appears as a terminal
    // window sitting on the user's desktop for as long as the app runs (0.1.35 shipped exactly that;
    // on a machine whose default terminal is Windows Terminal it opens as a WT window titled
    // "…\sc-overlay-server.exe"). Every OTHER spawn in this codebase already sets it; this one was
    // missed, and it only became visible when the sidecar stopped being spawned stdio:"ignore".
    // Inject the authoritative app version — the bun sidecar can't read package.json.
    server = spawn(exe, {
      cwd: path.dirname(exe), env: { ...process.env, APP_VERSION }, stdio, windowsHide: true,
    });
  } else {
    // Dev: run the TS server via tsx. Same flag, same reason — `shell:true` means cmd.exe, which is
    // a console app too.
    // SC_DEV unlocks the dev-replay endpoint (simulate finishing a mission without playing —
    // see src/dev-replay.ts). It is set HERE and nowhere else, so the packaged spawn above can
    // never carry it: that endpoint writes to the real blueprint collection, which syncs.
    server = spawn("npx tsx src/overlay-server.ts", {
      cwd: ROOT,
      shell: true,
      env: { ...process.env, APP_VERSION, SC_DEV: "1" },
      stdio,
      windowsHide: true,
    });
  }
  server.on("exit", (code, signal) => {
    if (app.isQuitting) return;
    // Everything the app can do depends on it, so bring it back rather than leaving a window
    // that looks healthy and answers nothing.
    if (serverRestarts >= 5) {
      noteInSidecarLog(`server exited (code ${code}, signal ${signal}) — 5 crashes, not restarting again`);
      console.error("[electron] server has crashed 5 times — not restarting it again");
      return;
    }
    const wait = Math.min(30000, 1000 * 2 ** serverRestarts);
    serverRestarts += 1;
    noteInSidecarLog(`server exited (code ${code}, signal ${signal}) — restarting in ${wait}ms (attempt ${serverRestarts})`);
    console.error(`[electron] server exited (code ${code}) — restarting in ${wait}ms, see ${SIDECAR_LOG}`);
    serverRestartTimer = setTimeout(startServer, wait);
  });
}

function waitForServer(tries = 60) {
  return new Promise((resolve) => {
    const ping = () => {
      http
        .get(`http://localhost:${PORT}/api/missions`, (r) => {
          r.resume();
          resolve(true);
        })
        .on("error", () => {
          if (--tries <= 0) return resolve(false);
          setTimeout(ping, 250);
        });
    };
    ping();
  });
}

function primaryBounds() {
  const b = screen.getPrimaryDisplay().bounds;
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}
// The union of every display = the whole virtual desktop. Its origin can be NEGATIVE when a
// monitor sits left/above the primary (e.g. x:-1080). The overlay canvas spans this so a widget
// can be dragged across monitors; the page renders widgets at their PRIMARY-relative position +
// the primary's offset within the canvas (overlay:canvas-info → px/py), so existing layouts stay
// put on the primary and only a deliberate drag carries a widget onto another display.
function virtualDesktopBounds() {
  const all = screen.getAllDisplays();
  const minX = Math.min(...all.map((d) => d.bounds.x));
  const minY = Math.min(...all.map((d) => d.bounds.y));
  const maxX = Math.max(...all.map((d) => d.bounds.x + d.bounds.width));
  const maxY = Math.max(...all.map((d) => d.bounds.y + d.bounds.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
// The widget overlay spans the virtual desktop (multi-monitor). fullDisplayBounds() drives the
// overlay window + overlay:canvas-info. (The binding-chart PNG stays PRIMARY-only — it's a
// gameplay reference overlay, not a widget canvas — so it uses primaryBounds() directly.)
function fullDisplayBounds() { return virtualDesktopBounds(); }
// Re-fit every canvas window when the monitor layout changes (plugged/unplugged/rearranged).
function refitCanvasWindows() {
  try { if (overlay && !overlay.isDestroyed()) overlay.setBounds(fullDisplayBounds()); } catch { /* ignore */ }
}

// The overlay is a FULL-SCREEN transparent canvas that hosts free-floating widgets (the Blueprint
// panel + Mining) — like Streamlabs/OBS. It spans the whole virtual desktop so a widget's
// decorations can hang into open canvas and widgets can be dragged/scaled/moved across monitors.
// Per-widget position/size/visibility live in widgets.json (see below), NOT a window-bounds file —
// the window itself is fixed. Click-through except over the widget the pointer is on (applyMouse).
function createOverlay() {
  const bounds = fullDisplayBounds(); // spans all monitors
  overlayLoaded = false; // a fresh window has no listeners until its did-finish-load
  overlay = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    icon: appIconPath(),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    // 🔑 `false` ON PURPOSE, and it is the only reason the overlay appears in Alt-Tab: that flag
    // hides a window from the taskbar, and Windows builds the Alt-Tab list from the same place.
    // Being switchable is the point — the overlay is click-through and Star Citizen recentres the
    // mouse while it has focus, so "Alt-Tab to the overlay" is how you take focus off the game and
    // use the widgets normally. `focusable: true` below was always set; only this was blocking it.
    skipTaskbar: false,
    alwaysOnTop: true,
    hasShadow: false,
    fullscreenable: false,
    focusable: true,
    // autoplayPolicy: the embedded Mining Assistant iframe plays alert tones / HAL voice via
    // Web Audio; allow it to sound without a prior user gesture (matches the old mining window).
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, "preload.cjs"), autoplayPolicy: "no-user-gesture-required" },
  });
  // Float above borderless fullscreen games.
  overlay.setAlwaysOnTop(true, "screen-saver");
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 🔑 Windows CLAMPS a transparent window's INITIAL (constructor) size to the display it opens
  // on, so a virtual-desktop-spanning size gets shrunk to the primary (window ends up positioned
  // at the desktop origin but only primary-sized → the canvas can't reach the other monitors).
  // setBounds AFTER creation isn't re-clamped, so force the real span here (and again once loaded).
  overlay.setBounds(bounds);
  // Clear any cached copy + cache-bust the URL so UI changes always show up.
  const hudUrl = `${HUD_URL}?v=${Date.now()}${AMD_COMPAT ? "&lite=1" : ""}`;
  overlay.webContents.session.clearCache().finally(() => overlay.loadURL(hudUrl));
  // Once the page is up, tell the renderer the mining widget's initial state: shown if the user
  // left it open last session, else armed-hidden if auto-show is on (so it can self-pop).
  overlay.webContents.on("did-finish-load", () => {
    try { overlay.setBounds(bounds); } catch { /* re-assert the full span past any creation-time clamp */ }
    // 🔑 `initial: true` marks this as REPLAYING saved state, not the user turning something on.
    // The renderer treats "turn this widget on" as "bring its tab to the front of its group" —
    // correct for a click, wrong here, because replaying nine widgets in order left whichever
    // member came last as the fronted tab and SAVED that over the user's choice. Without this
    // flag a stack can never remember which tab you were looking at.
    sendMiningVisible(miningVisible ? { on: true, initial: true } : { on: false, arm: miningArm, initial: true });
    sendNotepadVisible({ on: notepadVisible, initial: true });
    sendTwitchChatVisible({ on: twitchChatVisible, initial: true });
    sendScFeedVisible({ on: scFeedVisible, initial: true });
    sendUnlockAlertVisible({ on: unlockAlertVisible, initial: true });
    sendPartyVisible({ on: partyVisible, initial: true });
    sendBattagliaVisible({ on: battagliaVisible, initial: true });
    sendConfigWidgetVisible({ on: configWidgetVisible, initial: true });
    sendWebViewVisible({ on: webViewVisible, initial: true });
    sendBindingChartVisible({ on: bindingChartVisible, initial: true });
    pushWidgetStates();
    overlayLoaded = true;
    flushSetupNudge();
  });
  applyMouse();
  startMousePoll();
  // Focusing the overlay is now a deliberate act — it's in Alt-Tab, so switching to it means
  // "I want to use the overlay". Tell the renderer, which keeps the settings cog up for as long
  // as that lasts instead of fading it after 10s: having just switched to the thing, hunting for
  // its controls is exactly the wrong experience.
  const sendFocus = (on) => {
    if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:window-focus", on);
  };
  overlay.on("focus", () => sendFocus(true));
  overlay.on("blur", () => sendFocus(false));
  overlay.on("closed", () => {
    overlay = null;
    overlayLoaded = false;
  });
}

// ── per-widget layout persistence (canvas model) ─────────────────────────────
// Each widget's {x, y, scale, visible} lives in userData/widgets.json (in %APPDATA%, so it
// survives updates — same directory class as the *-bounds.json files). The page reads it on
// load and writes it back (debounced) as the user drags/resizes in arrange mode.
function widgetsFile() {
  return path.join(app.getPath("userData"), "widgets.json");
}
let widgetCache = null;
let widgetSaveTimer = null;
function readWidgets() {
  if (widgetCache) return widgetCache;
  try { widgetCache = JSON.parse(fs.readFileSync(widgetsFile(), "utf8")) || {}; }
  catch { widgetCache = {}; }
  return widgetCache;
}
function saveWidget(id, layout) {
  if (!id || !layout || typeof layout !== "object") return;
  const all = readWidgets();
  all[id] = { ...(all[id] || {}), ...layout };
  clearTimeout(widgetSaveTimer);
  widgetSaveTimer = setTimeout(() => {
    try { fs.writeFileSync(widgetsFile(), JSON.stringify(all)); }
    catch { /* non-fatal */ }
  }, 400);
}
// Recover widgets dragged off-screen / onto a disconnected monitor: wipe saved positions so
// every widget returns to its default on-screen spot. Also normalizes the global scale baseline
// back to 100% — otherwise a leftover scale (e.g. 200%) makes the reset widgets huge and
// ungrabbable. Reloads the pages so they re-read the layout.
async function resetWidgetLayout() {
  clearTimeout(widgetSaveTimer);
  widgetCache = {};
  try { fs.unlinkSync(widgetsFile()); } catch { /* already gone */ }
  try { await postConfig({ overlayScale: 100 }); } catch { /* sidecar down — non-fatal */ }
  try { overlay && !overlay.isDestroyed() && overlay.webContents.reload(); } catch { /* ignore */ }
}

function applyMouse() {
  if (!overlay) return;
  // The overlay is a full-screen canvas STACKED with the mining canvas, so it must stay
  // click-through except where its own widget is — otherwise (as full-screen interactive) it
  // would block the other window entirely. This is true even in arrange mode: interactivity
  // stays hover-based so clicks route to whichever widget is under the cursor, regardless of
  // which window is on top. Exceptions that force interactive: an active drag on THIS window
  // (so a gesture can't drop), or an open modal (hub / what's-new — clickable even when locked).
  // NOTE: no {forward:true} — on Windows that installs a system-wide low-level mouse hook per
  // window, and three full-screen overlays' worth of hooks stutters the whole cursor once the
  // app is elevated (UIPI stops masking them). `hovering` is driven by pollCursor() instead.
  // Default: clickable whenever the cursor is over a widget. Opt-in "hold to interact" mode
  // (holdMode) makes it passive UNLESS the interact key (default F) is held — so gameplay never
  // accidentally clicks it. Either way, dragging/modal force it interactive.
  // While editing a note, the notepad widget stays clickable without holding the interact key
  // (so you can reach Done / the fields), but the rest of the canvas stays click-through so the
  // game still gets clicks outside it — hence canHover, not a whole-window force.
  // 🔑 modalOpen must NOT force the WHOLE canvas interactive. It used to, which meant leaving any
  // widget's cog menu open made the entire screen swallow clicks — the game stopped responding
  // until you closed the menu. An open menu is already reported as an interactive REGION (see the
  // RSEL list in missions.html), so pollCursor's hit-test covers it; all `modalOpen` needs to do
  // is bypass hold-to-interact, so a modal stays clickable without holding the interact key.
  // Arrange mode is for MOVING and RESIZING widgets, so it must never require holding the
  // interact key — you'd be holding a key with one hand to drag with the other. The hold only
  // ever gates reaching INTO a widget's content (Sub, 2026-07-25).
  // 🔑 Hold-to-interact only applies while the GAME is in front (Sub, 2026-07-25). The hold exists
  // so gameplay can't accidentally click the HUD — on the desktop there's nothing to protect, and
  // demanding it there meant pressing the interact key (default "F", a plain letter) over Discord
  // or a browser, where it just typed an f into whatever had focus. We can't swallow the key: the
  // hook is deliberately passive/non-consuming (EAC-safe), so the fix is to not need it. Falls
  // back to the old always-hold behaviour until the foreground watcher has answered once, so a
  // failed helper can't silently make the overlay click-grabby mid-game.
  const holdActive = holdMode && (!foreground.ready() || foreground.gameInFront());
  const canHover = holdActive ? (holdInteract || notepadEditing || modalOpen || moveMode) : true;
  const interactive = dragging || (hovering && canHover);
  overlay.setIgnoreMouseEvents(!interactive);
}

// ── Cursor-poll hover detection (replaces setIgnoreMouseEvents forward:true) ──────
// Each page reports its interactive elements' client-rects (panel, summoned cog, open menus,
// arrange banner). We poll the OS cursor and flip a window interactive only while the cursor is
// actually over one of those rects — so the window is click-through everywhere else with NO
// mouse hook and NO screen-wide event forwarding.
let overlayRegions = []; // [{x,y,w,h}] in overlay-client coords (includes the mining widget)
let mousePoll = null;
function insideRegions(regions, win, pt) {
  if (!regions.length || !win || win.isDestroyed()) return false;
  const b = win.getBounds();
  for (const r of regions) {
    if (pt.x >= b.x + r.x && pt.x < b.x + r.x + r.w && pt.y >= b.y + r.y && pt.y < b.y + r.y + r.h) return true;
  }
  return false;
}
// How close the cursor is to the nearest interactive rect, in pixels (0 = inside one). Used to
// decide how often we need to keep looking.
function distanceToRegions(regions, win, pt) {
  if (!regions.length || !win || win.isDestroyed()) return Infinity;
  const b = win.getBounds();
  let best = Infinity;
  for (const r of regions) {
    const x1 = b.x + r.x, y1 = b.y + r.y;
    const dx = Math.max(x1 - pt.x, 0, pt.x - (x1 + r.w));
    const dy = Math.max(y1 - pt.y, 0, pt.y - (y1 + r.h));
    best = Math.min(best, Math.hypot(dx, dy));
    if (best === 0) return 0;
  }
  return best;
}
function pollCursor() {
  let pt; try { pt = screen.getCursorScreenPoint(); } catch { return; }
  // Back off while the cursor is nowhere near a widget. Hit-testing 33×/s matters only when the
  // pointer is about to cross a boundary; out in the middle of the game it's pure overhead, and
  // the cursor can't cover the slack distance faster than the slow tick.
  retuneMousePoll(distanceToRegions(overlayRegions, overlay, pt));
  if (overlay && !overlay.isDestroyed()) {
    const over = insideRegions(overlayRegions, overlay, pt);
    if (over !== hovering) {
      hovering = over; applyMouse();
      // Tell the page when the cursor has left everything. It can't work this out on its own:
      // the window is click-through by then, so it gets no mousemove and therefore no mouseleave
      // — which is why a widget whose header was revealed by a CLICK (any page with a text field
      // reports pointerdown to reveal its bar) kept that bar out forever.
      if (!over) { try { overlay.webContents.send("overlay:cursor-away"); } catch { /* gone */ } }
    }
    // The Web Page widget's content is a native view, so a cursor over it never reaches the
    // canvas DOM and :hover can never fire — that widget's bar would stay in forever while every
    // other widget's slides out. We are the only thing that can see this cursor, so we say so.
    // (Same reason `.touched` exists for iframes; a view is the harder version of that problem.)
    const onView = webViewPainted && insideRegions([{ x: webViewBounds.x, y: webViewBounds.y, w: webViewBounds.width, h: webViewBounds.height }], overlay, pt);
    if (onView !== webViewHover) {
      webViewHover = onView;
      try { overlay.webContents.send("webview:cursor", onView); } catch { /* gone */ }
    }
  }
}
// 30ms near a widget (the boundary has to feel instant), 200ms when the cursor is far from every
// one of them. NEAR_PX is generous enough that no realistic flick crosses the gap inside one slow
// tick, and any tick that finds itself close re-arms the fast rate before it matters.
const POLL_FAST_MS = 30, POLL_SLOW_MS = 200, NEAR_PX = 260;
let pollRate = 0;
function retuneMousePoll(dist) {
  const want = dist <= NEAR_PX ? POLL_FAST_MS : POLL_SLOW_MS;
  if (want === pollRate || !mousePoll) return;
  clearInterval(mousePoll);
  pollRate = want;
  mousePoll = setInterval(pollCursor, want);
}
function startMousePoll() {
  if (mousePoll) return;
  pollRate = POLL_FAST_MS;
  mousePoll = setInterval(pollCursor, POLL_FAST_MS);
}

// The binding chart is now a normal canvas WIDGET (overlay/bindingwidget.html) rather than a
// separate full-screen click-through window — you place and size it like everything else, and the
// binding hotkey toggles that widget. The old full-screen window was removed 2026-07-24: it
// rendered ON TOP of the widget and blocked it.

// Patch the sidecar config over HTTP (the config lives in the sidecar process).
async function postConfig(patch) {
  try {
    await fetch(`http://localhost:${PORT}/api/config`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch),
    });
  } catch { /* sidecar not up yet — non-fatal */ }
}

// ── Mining Assistant widget (in-canvas) ───────────────────────────────────────
// The Mining Assistant is now an iframe widget INSIDE the overlay canvas (see missions.html +
// mining.html?embedded=1), not its own window. The shell owns its VISIBILITY and drives it into
// the overlay renderer; the renderer shows/hides the widget and owns its layout, drag, and
// cursor hit-testing. setMiningVisible is the single mutator (keeps config + tray + hub in sync).
function sendMiningVisible(state) {
  try { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:mining-visible", state); }
  catch { /* renderer gone */ }
}
// Push widget on/off state to the in-overlay hub checkboxes (kept in sync with the tray).
function pushWidgetStates() {
  try { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:widget-states", { mining: miningVisible, notepad: notepadVisible, twitchChat: twitchChatVisible, scFeed: scFeedVisible, unlockAlert: unlockAlertVisible, party: partyVisible, battaglia: battagliaVisible, webView: webViewVisible, bindingChart: bindingChartVisible, config: configWidgetVisible }); }
  catch { /* renderer gone */ }
}
// The Notepad widget is a plain in-canvas iframe (no auto-show / SSE), so its visibility is a
// simple shell-owned flag pushed to the renderer — mirrors setMiningVisible, minus the arm/suppress.
function sendNotepadVisible(state) {
  try { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:notepad-visible", state); }
  catch { /* renderer gone */ }
}
function setNotepadVisible(on) {
  notepadVisible = !!on;
  // Hiding the notepad while typing mode is still active would strand notepadEditing=true, which
  // suspends the interact key (so hold-F would stop summoning the cog / interacting). Always clear
  // it on hide so the widget's edit state can't leak into global interaction.
  if (!notepadVisible && notepadEditing) { notepadEditing = false; notepadFocusPending = false; applyMouse(); }
  sendNotepadVisible({ on: notepadVisible });
  postConfig({ notepadOpen: notepadVisible }); // remember open/closed for next launch
  pushWidgetStates();
  refreshTray();
}
function toggleNotepad() { setNotepadVisible(!notepadVisible); }
// The Twitch Chat widget is another plain in-canvas iframe — same shell-owned visibility flag as
// the Notepad. (Its channel field shares the Notepad's keyboard-grab; the renderer drops typing
// mode when the widget hides, so nothing can strand the interact-key suspension.)
function sendTwitchChatVisible(state) {
  try { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:twitchchat-visible", state); }
  catch { /* renderer gone */ }
}
function setTwitchChatVisible(on) {
  twitchChatVisible = !!on;
  sendTwitchChatVisible({ on: twitchChatVisible });
  postConfig({ twitchChatOpen: twitchChatVisible }); // remember open/closed for next launch
  pushWidgetStates();
  refreshTray();
}
function toggleTwitchChat() { setTwitchChatVisible(!twitchChatVisible); }
// SC Feed news notifier — same shell-owned flag. "Visible" here means ARMED: the widget mounts
// and polls, but only paints when there's a new story (then fades itself out again).
function sendScFeedVisible(state) {
  try { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:scfeed-visible", state); }
  catch { /* renderer gone */ }
}
function setScFeedVisible(on) {
  scFeedVisible = !!on;
  sendScFeedVisible({ on: scFeedVisible });
  postConfig({ scFeedOpen: scFeedVisible }); // remember on/off for next launch
  pushWidgetStates();
  refreshTray();
}
function toggleScFeed() { setScFeedVisible(!scFeedVisible); }
// Blueprint-unlock notifier — armed like SC Feed: mounted and listening, but it only paints
// when a blueprint actually drops.
function sendUnlockAlertVisible(state) {
  try { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:unlockalert-visible", state); }
  catch { /* renderer gone */ }
}
function setUnlockAlertVisible(on) {
  unlockAlertVisible = !!on;
  sendUnlockAlertVisible({ on: unlockAlertVisible });
  postConfig({ unlockAlertOpen: unlockAlertVisible });
  pushWidgetStates();
  refreshTray();
}
function toggleUnlockAlert() { setUnlockAlertVisible(!unlockAlertVisible); }
// Party split widget — plain in-canvas iframe, same shell-owned visibility as the Notepad.
function sendPartyVisible(state) {
  try { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:party-visible", state); }
  catch { /* renderer gone */ }
}
function setPartyVisible(on) {
  partyVisible = !!on;
  sendPartyVisible({ on: partyVisible });
  postConfig({ partyOpen: partyVisible }); // remember open/closed for next launch
  pushWidgetStates();
  refreshTray();
}
function toggleParty() { setPartyVisible(!partyVisible); }
// Battaglia grind tracker - same shell-owned visibility as the widgets above. Retires when the
// giver does (4.10): drop this block, its config flag, and overlay/battaglia.html.
function sendBattagliaVisible(state) {
  try { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:battaglia-visible", state); }
  catch { /* renderer gone */ }
}
function setBattagliaVisible(on) {
  battagliaVisible = !!on;
  sendBattagliaVisible({ on: battagliaVisible });
  postConfig({ battagliaOpen: battagliaVisible }); // remember open/closed for next launch
  pushWidgetStates();
  refreshTray();
}
function toggleBattaglia() { setBattagliaVisible(!battagliaVisible); }

// Settings as a canvas widget — same shell-owned visibility contract as every widget above.
// The standalone settings WINDOW (openConfig) stays: the first-run wizard deep-links into it and
// must still work when the canvas is switched off or broken, which is exactly when someone needs
// to reach the AMD-compatibility and master-overlay switches.
function sendConfigWidgetVisible(state) {
  try { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:config-visible", state); }
  catch { /* window went away mid-send */ }
}
function setConfigWidgetVisible(on) {
  configWidgetVisible = !!on;
  sendConfigWidgetVisible({ on: configWidgetVisible });
  postConfig({ configOpen: configWidgetVisible }); // remember open/closed for next launch
  refreshTray();
}
function toggleConfigWidget() { setConfigWidgetVisible(!configWidgetVisible); }
// Web Page widget - any http(s) page the user pins to the canvas.
function sendWebViewVisible(state) {
  try { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:webview-visible", state); }
  catch { /* renderer gone */ }
}
function setWebViewVisible(on) {
  webViewVisible = !!on;
  sendWebViewVisible({ on: webViewVisible });
  postConfig({ webViewOpen: webViewVisible });
  pushWidgetStates();
  refreshTray();
}
function toggleWebView() { setWebViewVisible(!webViewVisible); }
// Binding Chart widget — the placeable, sizeable panel that REPLACED the old full-screen
// click-through binding window. The binding hotkey toggles this.
function sendBindingChartVisible(state) {
  try { if (overlay && !overlay.isDestroyed()) overlay.webContents.send("overlay:bindingchart-visible", state); }
  catch { /* renderer gone */ }
}
function setBindingChartVisible(on) {
  bindingChartVisible = !!on;
  // Re-read the PNG each time it's summoned so a re-exported chart shows up without a restart
  // (the retired full-screen window bumped a location hash for the same reason).
  if (bindingChartVisible) {
    try { overlay && !overlay.isDestroyed() && overlay.webContents.send("overlay:bindingchart-reload"); }
    catch { /* renderer gone */ }
  }
  sendBindingChartVisible({ on: bindingChartVisible });
  postConfig({ bindingChartOpen: bindingChartVisible });
  pushWidgetStates();
  refreshTray();
}
function toggleBindingChart() { setBindingChartVisible(!bindingChartVisible); }
function setMiningVisible(on, opts) {
  opts = opts || {};
  on = !!on;
  miningVisible = on;
  // A manual hide (tray/hotkey/hub off) suppresses auto-show briefly, so it doesn't re-pop on
  // the next scan/refinery read the player didn't ask to see.
  if (!on && opts.manual) miningAutoSuppress = Date.now() + 90000;
  sendMiningVisible({ on });
  // Scan only while the Mining Assistant widget is actually open. This disables
  // OCR/signature polling when the widget is closed.
  postConfig({ miningAssistant: on });
  // Remember open/closed for next launch — but an AUTO-SHOW pop (persist:false) must NOT make
  // mining permanently "open"; only an explicit user open/close persists.
  if (opts.persist !== false) postConfig({ miningOpen: on });
  pushWidgetStates();
  refreshTray();
}
function toggleMining() {
  if (miningVisible) setMiningVisible(false, { manual: true });
  else { miningAutoSuppress = 0; setMiningVisible(true); }
}

// Live-rebindable global shortcut for the binding-chart overlay — swap it WITHOUT a restart.
// Returns {ok:true} or {ok:false,error} so the config window can warn (invalid combo, or the
// combo is already claimed by another app).
// Live-rebindable global shortcut for showing/hiding the overlay HUD. Same shape as
// registerBindingHotkey so the config window can warn on an invalid / in-use combo.
let overlayAccel = null;
function registerOverlayHotkey(accel) {
  if (overlayAccel) hotkeys.unregister(overlayAccel);
  overlayAccel = null;
  if (!accel || typeof accel !== "string") return { ok: true };
  const r = hotkeys.register(accel, toggleShow);
  if (r.ok) overlayAccel = accel;
  return r;
}

let bindingAccel = null;
function registerBindingHotkey(accel) {
  if (bindingAccel) hotkeys.unregister(bindingAccel);
  bindingAccel = null;
  if (!accel || typeof accel !== "string") return { ok: true };
  const r = hotkeys.register(accel, toggleBindingChart);
  if (r.ok) bindingAccel = accel;
  return r;
}

// Live-rebindable hotkey for showing/hiding the Web Page widget - same shape as the others.
let webViewAccel = null;
function registerWebViewHotkey(accel) {
  if (webViewAccel) hotkeys.unregister(webViewAccel);
  webViewAccel = null;
  if (!accel || typeof accel !== "string") return { ok: true };
  const r = hotkeys.register(accel, () => setWebView(!webViewVisible));
  if (r.ok) webViewAccel = accel;
  return r;
}

// Live-rebindable hotkey for showing/hiding the Mining Assistant widget. Same shape as the
// overlay/binding registrations so the config window can warn on an invalid / in-use combo.
let miningAccel = null;
function registerMiningHotkey(accel) {
  if (miningAccel) hotkeys.unregister(miningAccel);
  miningAccel = null;
  if (!accel || typeof accel !== "string") return { ok: true };
  const r = hotkeys.register(accel, toggleMining);
  if (r.ok) miningAccel = accel;
  return r;
}

// Interact-to-hold (default F): the overlay is passive until you HOLD this key — then it's
// clickable over its widgets, so it never eats a click during gameplay. Requires the low-level
// hook (key-up detection). Move (arrange mode) stays a normal press hotkey.
let interactAccel = null;
function registerInteractHotkey(accel) {
  if (interactAccel) hotkeys.unregister(interactAccel);
  interactAccel = null;
  if (!accel || typeof accel !== "string") return { ok: true };
  const r = hotkeys.registerHold(accel,
    // On press (only matters in opt-in hold mode): allow interaction AND summon the global cog so
    // settings are reachable while held. In the default hover mode this key does nothing.
    // Down: normal hold-to-interact — BUT while typing a note the interact key is suspended, so it
    // types as a plain character (e.g. "F") instead of toggling interaction.
    () => { if (!holdMode || notepadEditing) return; holdInteract = true; applyMouse(); try { overlay && !overlay.isDestroyed() && overlay.webContents.send("overlay:summon-cog"); } catch { /* ignore */ } },
    // Up: end the hold; and if a note is waiting to be focused (the key was held to click "Type"),
    // focus it NOW that the key is released so no stray character lands in the field.
    () => {
      if (holdInteract) { holdInteract = false; applyMouse(); }
      if (notepadFocusPending) { notepadFocusPending = false; try { overlay && !overlay.isDestroyed() && overlay.webContents.send("overlay:notepad-focus"); } catch { /* ignore */ } }
    });
  if (r.ok) interactAccel = accel;
  return r;
}
let moveAccel = null;
function registerMoveHotkey(accel) {
  if (moveAccel) hotkeys.unregister(moveAccel);
  moveAccel = null;
  if (!accel || typeof accel !== "string") return { ok: true };
  const r = hotkeys.register(accel, toggleMove);
  if (r.ok) moveAccel = accel;
  return r;
}

// Confirms a fabricator claim prompt. Goes straight to the SIDECAR rather than into the widget:
// the sidecar owns the prompt (including its 30s expiry), and its broadcast is what clears the
// card — so a hotkey press and a button click travel the exact same path and can't disagree.
// A press with no prompt live is a harmless no-op the server answers with why:"expired".
let fabClaimAccel = null;
function registerFabClaimHotkey(accel) {
  if (fabClaimAccel) hotkeys.unregister(fabClaimAccel);
  fabClaimAccel = null;
  if (!accel || typeof accel !== "string") return { ok: true };
  const r = hotkeys.register(accel, () => postApi("/api/fab/claim?accept=1"));
  if (r.ok) fabClaimAccel = accel;
  return r;
}

// ── actions ─────────────────────────────────────────────────────────────────

// Reposition mode: whole panel becomes a drag surface (banner + Done in the page),
// hover-toggling suspended so the window can't slip out from under the cursor.
function setMoveMode(on) {
  moveMode = on;
  applyMouse();
  if (on && overlay) overlay.focus();
  overlay?.webContents.send("overlay:move-mode", on);
  refreshTray();
}
// Global arrange: one cohesive overlay app. Both widgets (Blueprint + Mining) now live in the
// one overlay renderer, so a single move-mode message puts EVERY visible widget into
// move/resize at once (the renderer's onMoveMode toggles both), and any "Done" exits for all.
// Triggered by a widget's grip, the global cog's Arrange button, the tray, or Ctrl+Alt+M.
let arrangeAll = false;
function setArrangeAll(on) {
  arrangeAll = on;
  setMoveMode(on); // drives the overlay renderer (both widgets) + refreshes the tray
}
function toggleMove() {
  setArrangeAll(!arrangeAll);
}

// Master overlay switch (persisted). OFF fully DESTROYS the transparent always-on-top HUD
// window — not just hides it — so it can't composite over the game (the AMD device-lost /
// TDR trigger), while the sidecar server + game.log watcher keep running so blueprint
// tracking + sync are unaffected. This is both the crash workaround and the "is it the
// overlay?" diagnostic. Reflected live in the tray + any open config window.
function setOverlayEnabled(on) {
  overlayEnabled = on;
  writeOverlayEnabled(on);
  if (on) {
    if (!overlay) createOverlay();
  } else {
    moveMode = false;
    if (overlay) {
      overlay.destroy();
      overlay = null;
    }
  }
  configWin?.webContents.send("overlay:enabled-changed", on);
  // Settings also runs as a canvas WIDGET, whose copy of the master-switch checkbox needs the
  // same signal. Only meaningful when turning ON — switching off destroys the canvas, and the
  // widget with it, so there is nothing left to tell. 🔑 That is also why the tray keeps this
  // toggle: turning the overlay off from inside the overlay is a one-way trip otherwise.
  if (on) overlay?.webContents.send("overlay:enabled-changed", on);
  refreshTray();
}
function toggleShow() {
  setOverlayEnabled(!overlayEnabled);
}

function openConfig() {
  if (configWin) { configWin.show(); configWin.focus(); return; }
  // Size the window to the display so it (and its auto-scaled content — config.html applies the
  // same screen.height/1080 zoom) is readable on a 4K TV instead of a tiny 780px box. Clamp to the
  // work area, and center on whichever display the cursor is on.
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const scale = Math.max(1, Math.min(2.25, disp.size.height / 1080));
  const width = Math.min(disp.workArea.width - 40, Math.round(780 * scale));
  const height = Math.min(disp.workArea.height - 40, Math.round(860 * scale));
  const x = Math.round(disp.workArea.x + (disp.workArea.width - width) / 2);
  const y = Math.round(disp.workArea.y + (disp.workArea.height - height) / 2);
  configWin = new BrowserWindow({
    x, y, width, height,
    title: "SC Overlay — Config",
    icon: appIconPath(),
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, "config-preload.cjs") },
  });
  // The overlays float at the highest ("screen-saver") always-on-top level so they clear a
  // fullscreen game. Put the settings window at the SAME level so it's never buried under the
  // binding-chart / HUD overlay — otherwise you can't get back to settings once one is up.
  configWin.setAlwaysOnTop(true, "screen-saver");
  configWin.loadURL(`${CONFIG_URL}?v=${Date.now()}`);
  configWin.on("closed", () => {
    configWin = null;
  });
}

// ── first-run setup wizard ────────────────────────────────────────────────────
// Same window treatment as Settings (screen-scaled, screen-saver always-on-top) so it can't
// be buried under the HUD. Slightly wider than Settings because it's a rail + pane layout.
function openSetup() {
  if (setupWin) { setupWin.show(); setupWin.focus(); return; }
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const scale = Math.max(1, Math.min(2.25, disp.size.height / 1080));
  const width = Math.min(disp.workArea.width - 40, Math.round(900 * scale));
  const height = Math.min(disp.workArea.height - 40, Math.round(640 * scale));
  const x = Math.round(disp.workArea.x + (disp.workArea.width - width) / 2);
  const y = Math.round(disp.workArea.y + (disp.workArea.height - height) / 2);
  setupWin = new BrowserWindow({
    x, y, width, height,
    title: "SC Overlay — Setup",
    icon: appIconPath(),
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, "setup-preload.cjs") },
  });
  setupWin.setAlwaysOnTop(true, "screen-saver");
  setupWin.loadURL(`${SETUP_URL}?v=${Date.now()}`);
  setupWin.on("closed", () => { setupWin = null; });
}

/** Open the wizard on a FIRST run, or drop the one-time banner on an existing user who never
 *  finished setup. The distinction matters: the wizard takes over the screen, and doing that
 *  to someone who has been running the app for months reads as the update breaking something.
 *  🔑 Asks the SIDECAR rather than deciding here — `freshInstall` is judged there, before
 *  anything can write a config, and the shell has no equivalent signal of its own. */
async function maybeRunSetup() {
  let s = null;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/setup`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) s = await r.json();
  } catch { /* sidecar not up yet — a wizard we can't populate is worse than none */ }
  if (!s || s.setupDone) return;
  if (s.freshInstall) { openSetup(); return; }
  // Existing user: nudge only, and only once. The canvas owns the banner; if the overlay is
  // switched off there's nowhere to show it, and it simply waits for a launch where there is.
  if (!s.nudgeDismissed) {
    const unresolved = Object.keys(s.steps).filter((k) => !s.steps[k].done && !s.steps[k].optional);
    if (unresolved.length) { pendingSetupNudge = { steps: unresolved.length }; flushSetupNudge(); }
  }
}

/** 🔑 The nudge is QUEUED, not sent directly. This runs during startup, racing the canvas's
 *  first load — a send that lands before the page's listener exists is dropped silently, which
 *  is the same trap the widget-visibility replay hit (hence the did-finish-load push above).
 *  So it's held here and flushed by whichever of the two finishes second.
 *  🔑 Gated on `overlayLoaded`, NOT on `overlay` being non-null: the window object exists the
 *  moment createOverlay() returns, long before its page has a listener, so testing the window
 *  would "deliver" the nudge into nothing and then clear the queue. */
let pendingSetupNudge = null;
function flushSetupNudge() {
  if (!pendingSetupNudge || !overlay || !overlayLoaded) return;
  overlay.webContents.send("overlay:setup-nudge", pendingSetupNudge);
  pendingSetupNudge = null;
}

// ── run-as-administrator (for in-game hotkeys) ────────────────────────────────
// Star Citizen runs elevated (Easy Anti-Cheat), and Windows UIPI won't let a normal-privilege
// app's low-level keyboard hook see keystrokes while an elevated window is focused. So the
// hotkeys only work in-game if THIS app is elevated too. We don't force it (no UAC nag for
// casual users) — the config window offers an opt-in "Restart as administrator".
let cachedElevated = null; // null=unknown, true/false once checked (doesn't change per run)
function checkElevated() {
  return new Promise((resolve) => {
    if (cachedElevated !== null) return resolve(cachedElevated);
    if (process.platform !== "win32") { cachedElevated = false; return resolve(false); }
    try {
      const { execFile } = require("node:child_process");
      execFile("powershell", ["-NoProfile", "-Command",
        "[bool]([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)"],
        { windowsHide: true, timeout: 4000 }, (err, stdout) => {
          cachedElevated = !err && /true/i.test(String(stdout));
          resolve(cachedElevated);
        });
    } catch { cachedElevated = false; resolve(false); }
  });
}
// Relaunch the app elevated via ShellExecute "runas" (UAC prompt), then quit this instance so
// the elevated one can take the single-instance lock + the sidecar port. Detached PowerShell
// so the elevation survives our exit.
function restartAsAdmin() {
  const logPath = path.join(app.getPath("userData"), "restart-admin.log");
  const mlog = (m) => { try { fs.appendFileSync(logPath, `[${new Date().toISOString()}] main: ${m}\r\n`); } catch { /* best-effort */ } };
  try {
    const exe = process.execPath;
    const args = app.isPackaged ? [] : [path.join(__dirname, "main.cjs")]; // dev: pass the entry script (absolute)
    // 🔑 -WorkingDirectory must be a REAL directory. ROOT is `<install>\resources\app.asar`
    // when packaged (a FILE, not a dir) → Start-Process fails ("directory name is invalid")
    // and the elevated instance never launches. Use the exe's own dir when packaged.
    const wd = app.isPackaged ? path.dirname(exe) : ROOT;
    const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    const argList = args.length ? ` -ArgumentList @(${args.map(q).join(",")})` : "";
    // The handoff runs from a detached HELPER SCRIPT (not an inline -Command) so it can transcript
    // every step to restart-admin.log — otherwise elevation failures are invisible (the app just
    // closes). The helper waits for THIS instance to fully exit, sweeps any leftover sidecar, THEN
    // relaunches elevated; without the wait the new instance races the dying old one and bounces off
    // the single-instance lock / held :8778. Start-Process uses -ErrorAction Stop + try/catch so a
    // declined/blocked UAC is logged with its exact message instead of being swallowed by stdio:ignore.
    const helper = [
      `$ErrorActionPreference = 'Continue'`,
      `$log = ${q(logPath)}`,
      `function W($m){ try { Add-Content -LiteralPath $log -Value ('[' + (Get-Date -Format o) + '] helper: ' + $m) } catch {} }`,
      `W 'started; waiting for old instance (pid ${process.pid}) to exit'`,
      `Wait-Process -Id ${process.pid} -Timeout 10 -ErrorAction SilentlyContinue`,
      `W 'old instance gone (or 10s timeout); sweeping leftover sidecar'`,
      `Get-Process -Name 'sc-overlay-server' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`,
      `try {`,
      `  W 'requesting elevated relaunch (UAC): ${exe.replace(/'/g, "''")}'`,
      `  Start-Process -FilePath ${q(exe)}${argList} -WorkingDirectory ${q(wd)} -Verb RunAs -ErrorAction Stop`,
      `  W 'elevated relaunch accepted'`,
      `} catch {`,
      `  W ('ELEVATION FAILED: ' + $_.Exception.Message)`,
      `}`,
    ].join("\r\n");
    const helperPath = path.join(app.getPath("temp"), "sc-overlay-elevate.ps1");
    fs.writeFileSync(helperPath, helper, "utf8");
    mlog(`spawning elevation helper (isPackaged=${app.isPackaged}, exe=${exe})`);
    spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", helperPath],
      { detached: true, stdio: "ignore", windowsHide: true }).unref();
    app.isQuitting = true;
    setTimeout(() => app.quit(), 400); // begin our own shutdown; the helper waits for us to exit
  } catch (e) {
    console.error("[restart-as-admin]", String(e));
    mlog(`EXCEPTION ${String(e)}`);
  }
}

function postApi(p) {
  const req = http.request({ host: "localhost", port: PORT, path: p, method: "POST" }, (r) => r.resume());
  req.on("error", () => {});
  req.end();
}
function verifyFromLogs() {
  postApi("/api/missions/verify");
}
function refreshMissions() {
  // Re-read the log and drop stale missions (e.g. after a server change).
  postApi("/api/missions/refresh");
}

// Auto-update via electron-updater. Feed URL comes from the `publish` config
// (subliminal.gg proxies the private GitHub release). Silent background download,
// then a prompt to restart. No-op in dev (unpackaged).
function setupUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  // Force a full streamed download instead of a block-differential one. The differential path
  // emits NO download-progress events (so the tray sits at 0% the whole time), and because our
  // installer isn't block-aligned across builds it re-downloads nearly the full file anyway via
  // hundreds of slow ranged requests. A single full download is faster here and drives the tray %.
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.on("update-downloaded", (info) => {
    updateDownload = null;
    refreshTray();
    if (tray) tray.setToolTip("SC Overlay");
    dialog
      .showMessageBox({
        type: "info",
        title: "Update ready",
        message: `SC Overlay ${info.version} is ready to install.`,
        detail: "Restart now to update?",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
        cancelId: 1,
      })
      .then((r) => {
        if (r.response === 0) {
          app.isQuitting = true;
          autoUpdater.quitAndInstall();
        }
      });
  });
  // Manual checks (tray "Check for updates") get feedback; the automatic launch +
  // 3-hourly checks stay silent (manualCheck gates the extra dialogs).
  autoUpdater.on("update-available", (info) => {
    // Start the tray progress readout for BOTH auto and manual checks.
    updateDownload = { version: info.version, percent: 0, bps: 0 };
    refreshTray();
    if (!manualCheck) return;
    manualCheck = false;
    dialog.showMessageBox({
      type: "info", title: "Update available",
      message: `SC Overlay ${info.version} is available.`,
      detail: "Downloading in the background — the tray menu shows live progress, and you'll be prompted to restart when it's ready.",
      buttons: ["OK"],
    });
  });
  // Live download progress → tray menu line + tray tooltip. Menu rebuilds are
  // throttled to whole-percent changes (an open menu is a snapshot; the next
  // open shows the current number).
  autoUpdater.on("download-progress", (p) => {
    if (!updateDownload) updateDownload = { version: "", percent: 0, bps: 0 };
    const pct = Math.floor(p.percent);
    updateDownload.bps = p.bytesPerSecond;
    if (tray) tray.setToolTip(`SC Overlay — downloading update ${pct}%`);
    if (pct !== updateDownload.percent) {
      updateDownload.percent = pct;
      refreshTray();
    }
  });
  autoUpdater.on("update-not-available", () => {
    if (!manualCheck) return;
    manualCheck = false;
    dialog.showMessageBox({
      type: "info", title: "No updates",
      message: `You're on the latest version (${app.getVersion()}).`,
      buttons: ["OK"],
    });
  });
  autoUpdater.on("error", (e) => {
    console.error("[updater]", String(e));
    updateDownload = null;
    refreshTray();
    if (tray) tray.setToolTip("SC Overlay");
    if (!manualCheck) return;
    manualCheck = false;
    dialog.showMessageBox({
      type: "error", title: "Update check failed",
      message: "Couldn't check for updates right now.", detail: String(e),
      buttons: ["OK"],
    });
  });
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 3 * 60 * 60 * 1000);
}

// Tray "Check for updates" — kicks a check with visible feedback. In dev (unpackaged)
// there's no updater, so just say so.
function checkForUpdatesManual() {
  if (!app.isPackaged) {
    dialog.showMessageBox({
      type: "info", title: "Check for updates",
      message: "Updates are only available in the installed app.",
      buttons: ["OK"],
    });
    return;
  }
  manualCheck = true;
  autoUpdater.checkForUpdates().catch((e) => {
    manualCheck = false;
    console.error("[updater]", String(e));
  });
}

// ── tray ────────────────────────────────────────────────────────────────────
function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Show in-game overlay",
        type: "checkbox",
        checked: overlayEnabled,
        click: () => setOverlayEnabled(!overlayEnabled),
      },
      ...(overlayEnabled
        ? [{ label: moveMode ? "Done arranging" : "Arrange widgets…", click: toggleMove },
            { label: "Reset overlay layout (recover lost widgets)", click: resetWidgetLayout }]
        : [{ label: "Overlay off — tracking still running", enabled: false }]),
      { type: "separator" },
      // Widgets — every one a checkbox under a heading, so it's obvious the menu toggles them
      // on and off rather than "opening" something.
      { label: "Widgets", enabled: false },
      { label: "Mining Scanner", type: "checkbox", checked: miningVisible, click: toggleMining },
      { label: "Journal", type: "checkbox", checked: notepadVisible, click: toggleNotepad },
      { label: "Twitch Chat", type: "checkbox", checked: twitchChatVisible, click: toggleTwitchChat },
      { label: "SC Feed", type: "checkbox", checked: scFeedVisible, click: toggleScFeed },
      { label: "Unlock Alerts", type: "checkbox", checked: unlockAlertVisible, click: toggleUnlockAlert },
      { label: "Loot Split", type: "checkbox", checked: partyVisible, click: toggleParty },
      { label: "Event Tracker", type: "checkbox", checked: battagliaVisible, click: toggleBattaglia },
      { label: "Settings", type: "checkbox", checked: configWidgetVisible, click: toggleConfigWidget },
      { label: "Web Page", type: "checkbox", checked: webViewVisible, click: toggleWebView },
      { label: "Infographic Viewer", type: "checkbox", checked: bindingChartVisible, click: toggleBindingChart },
      { type: "separator" },
      { label: "Tools", enabled: false },
      { label: "Refresh missions (re-read log)", click: refreshMissions },
      { label: "Verify from logs", click: verifyFromLogs },
      { label: "Settings…", click: openConfig },
      { label: "Run setup again…", click: openSetup },
      ...(cachedElevated === false
        ? [{ label: "Restart as administrator (for in-game hotkeys)", click: restartAsAdmin }]
        : []),
      { type: "separator" },
      ...(updateDownload
        ? [{
            label: `Downloading ${updateDownload.version ? "v" + updateDownload.version : "update"} — ${updateDownload.percent}%` +
              (updateDownload.bps ? ` (${(updateDownload.bps / 1048576).toFixed(1)} MB/s)` : ""),
            enabled: false,
          }]
        : [{ label: "Check for updates…", click: checkForUpdatesManual }]),
      { label: `Version ${app.getVersion()}`, enabled: false },
      {
        label: "View source on GitHub",
        click: () => shell.openExternal("https://github.com/SubliminalsTV-Projects/sc-overlay"),
      },
      { type: "separator" },
      { label: "Quit", click: () => app.quit() },
    ]),
  );
}

/** The app icon, for the tray AND every window.
 *  🔑 The asar only packs electron/**, so overlay/ isn't inside it — in the packaged app the
 *  icon ships with the sidecar under resources/server/overlay/. Resolve there when packaged,
 *  else from the repo (dev). (Resolving from ROOT/overlay when packaged → blank tray.)
 *  `build/icon.png` is NOT usable here: it is only an electron-builder input and never ships.
 *  A window with no `icon:` falls back to the EXECUTABLE's icon, which in dev is electron.exe —
 *  which is why the Electron logo showed up on the settings window, the wizard, and (now that
 *  the overlay is Alt-Tabbable) the overlay's own taskbar entry. */
function appIconPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "server", "overlay", "tray-icon.png")
    : path.join(ROOT, "overlay", "tray-icon.png");
}

function createTray() {
  const icon = nativeImage.createFromPath(appIconPath());
  tray = new Tray(icon);
  tray.setToolTip("SC Overlay");
  tray.on("click", toggleShow);
  refreshTray();
}

// ── app lifecycle ─────────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (overlay) {
      overlay.show();
      refreshTray();
    }
  });

  app.whenReady().then(async () => {
    // One helper answers "who's in front" for both the OCR gate and hold-to-interact — and only
    // runs while one of them actually wants it (see foreground.want). Alt-tabbing in or out of the
    // game changes whether the hold is required, so re-evaluate on every change rather than
    // waiting for something else to notice.
    foreground.onChange(() => {
      applyMouse();
      // The canvas needs the same answer for its own reason: a summoned cog / open hub should
      // time itself out once you're back in the GAME, since that's when it's forgotten about.
      // Pushed rather than polled — the page can't see the desktop, and this fires only on an
      // actual change of foreground window.
      try {
        if (overlay && !overlay.isDestroyed()) {
          overlay.webContents.send("overlay:game-focus", foreground.gameInFront());
        }
      } catch { /* window gone */ }
    });
    startServer();
    const up = await waitForServer();
    if (!up) console.error("[electron] server did not come up on :" + PORT);
    overlayEnabled = readOverlayEnabled();
    if (overlayEnabled) createOverlay();
    createTray();
    setupUpdater();
    // First run → wizard; existing user with unfinished setup → one dismissible banner. Runs
    // after createOverlay() because the banner is sent to the canvas, and only when the server
    // actually answered — the wizard reads every step's state from it.
    if (up) void maybeRunSetup();
    // Keep the canvas windows covering the whole virtual desktop when monitors change.
    screen.on("display-added", refitCanvasWindows);
    screen.on("display-removed", refitCanvasWindows);
    screen.on("display-metrics-changed", refitCanvasWindows);
    // Configurable global hotkeys (live-rebindable from the config window), read from the
    // persisted config: overlay show/hide (F3), binding-chart PNG (Ctrl+F3), Mining (Shift+F3),
    // Interact-to-hold (F — hold to click the overlay), and Move/arrange (Ctrl+Alt+M).
    let overlayKey = "F3";
    let bindKey = "Ctrl+F3";
    let miningKey = "Shift+F3";
    let interactKey = "F";
    let moveKey = "Ctrl+Alt+M";
    let fabClaimKey = "F4";
    try {
      const p = path.join(process.env.APPDATA || process.env.HOME || ".", "sc-blueprint-tracker", "config.json");
      const c = JSON.parse(fs.readFileSync(p, "utf8"));
      // 🔑 `typeof === "string"`, not truthiness: a hotkey the user CLEARED is saved as "", and a
      // falsy test read that as "not configured" and handed the default straight back — so a
      // removed hotkey came back on the next launch. Absent (undefined) means never set, and only
      // that takes the default. Registering "" is already a no-op, so no other change is needed.
      if (typeof c.overlayHotkey === "string") overlayKey = c.overlayHotkey;
      if (typeof c.bindingHotkey === "string") bindKey = c.bindingHotkey;
      if (typeof c.webViewHotkey === "string") registerWebViewHotkey(c.webViewHotkey);
      if (typeof c.miningHotkey === "string") miningKey = c.miningHotkey;
      if (typeof c.interactHotkey === "string") interactKey = c.interactHotkey;
      if (typeof c.moveHotkey === "string") moveKey = c.moveHotkey;
      if (typeof c.fabClaimHotkey === "string") fabClaimKey = c.fabClaimHotkey;
      if (c.holdToInteract === true) holdMode = true; // opt-in: require holding the interact key
    } catch { /* defaults */ }
    foreground.want("hold", holdMode); // only track the foreground app if something asks
    registerOverlayHotkey(overlayKey);
    registerBindingHotkey(bindKey);
    registerMiningHotkey(miningKey);
    registerInteractHotkey(interactKey);
    registerMoveHotkey(moveKey);
    registerFabClaimHotkey(fabClaimKey);
    // Learn our elevation state (async) so the tray can offer "Restart as administrator" when
    // we're NOT elevated — the state hotkeys-over-a-focused-game depend on.
    checkElevated().then(() => refreshTray());
    // Restore the Mining Assistant widget: if the user left it OPEN last session, show it; else,
    // if auto-show is on, ARM it (the overlay loads the mining iframe hidden so it's listening on
    // the event stream and can pop itself when the scanner/refinery screen is detected). The
    // overlay's did-finish-load handler pushes this initial state into the renderer.
    try {
      const p = path.join(process.env.APPDATA || process.env.HOME || ".", "sc-blueprint-tracker", "config.json");
      const c = JSON.parse(fs.readFileSync(p, "utf8"));
      miningVisible = c.miningOpen === true;
      miningArm = !miningVisible && c.miningAutoShow === true;
      notepadVisible = c.notepadOpen === true;
      twitchChatVisible = c.twitchChatOpen === true;
      scFeedVisible = c.scFeedOpen === true;
      unlockAlertVisible = c.unlockAlertOpen !== false; // default ON — it replaced an existing toast
      partyVisible = c.partyOpen === true;
      battagliaVisible = c.battagliaOpen === true;
      configWidgetVisible = c.configOpen === true;
      webViewVisible = c.webViewOpen === true;
      bindingChartVisible = c.bindingChartOpen === true;
    } catch { /* default off */ }
    // Keep capture gating aligned on launch: closed mining widget => no mining scan.
    postConfig({ miningAssistant: miningVisible });
    // Opt-in fabricator screen-capture loop (config.fabCapture). No-op until enabled.
    startFabCapture({
      port: PORT,
      configDir: path.join(process.env.APPDATA || process.env.HOME || ".", "sc-blueprint-tracker"),
      onStatus: (s) => { try { overlay?.webContents.send("overlay:ocr", s); } catch { /* window gone */ } },
    });
  });

  // Native PNG picker for the config window (renderers can't open OS dialogs).
  ipcMain.handle("pick-png", async () => {
    const r = await dialog.showOpenDialog(configWin ?? undefined, {
      title: "Choose a PNG to overlay",
      filters: [{ name: "PNG image", extensions: ["png"] }],
      properties: ["openFile"],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });

  // Mining Assistant: custom alert-tone WAV picker + show (for auto-pop-up). The chosen
  // path is persisted server-side (config.miningTone) so the sidecar can serve it.
  ipcMain.handle("mining:pick-tone", async () => {
    const r = await dialog.showOpenDialog(overlay ?? undefined, {
      title: "Choose an alert-tone WAV",
      filters: [{ name: "WAV audio", extensions: ["wav"] }],
      properties: ["openFile"],
    });
    if (r.canceled || !r.filePaths.length) return false;
    await postConfig({ miningTone: r.filePaths[0] });
    return true;
  });
  ipcMain.handle("mining:clear-tone", async () => { await postConfig({ miningTone: "" }); return true; });
  // Auto-show request from the embedded mining page (a new scan / refinery read). Gated by the
  // suppress window so a manual hide keeps it out of the way for a bit. The config.miningAutoShow
  // opt-in is checked page-side before this fires; here we just enforce the suppress + not-already-shown.
  ipcMain.on("mining:show", () => {
    if (miningVisible) return;
    if (Date.now() < miningAutoSuppress) return;
    setMiningVisible(true, { persist: false }); // auto-show pop — don't persist as "open"
  });

  // Config window's "Show in-game overlay" toggle (crash workaround). Owned here, not by
  // the sidecar config, so destroy/create is immediate.
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("app:is-elevated", () => checkElevated());
  ipcMain.handle("app:restart-as-admin", () => { restartAsAdmin(); return true; });
  ipcMain.handle("overlay:get-enabled", () => overlayEnabled);
  ipcMain.handle("overlay:set-enabled", (_e, on) => {
    setOverlayEnabled(!!on);
    return overlayEnabled;
  });

  // Native FILE picker for the game.log path — an open-FILE dialog (not a folder), filtered
  // to .log, so users select the actual game.log rather than the directory it lives in.
  ipcMain.handle("pick-log", async (_e, current) => {
    const r = await dialog.showOpenDialog(configWin ?? undefined, {
      title: "Select your game.log file",
      defaultPath: typeof current === "string" && current ? current : undefined,
      filters: [
        { name: "Star Citizen log (game.log)", extensions: ["log"] },
        { name: "All files", extensions: ["*"] },
      ],
      properties: ["openFile"],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });

  // ── setup wizard ────────────────────────────────────────────────────────────
  ipcMain.on("setup:open-settings", () => openConfig());
  // Re-validated here, not just in the preload: a renderer is never the authority on what the
  // shell is allowed to launch. https only, same rule as overlay:open-url.
  ipcMain.on("setup:open-external", (_e, url) => {
    if (typeof url === "string" && /^https:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
  });
  ipcMain.on("setup:close", () => setupWin?.close());
  // The nudge banner's "set it up" button, and its dismiss. Both come from the canvas.
  ipcMain.on("setup:open-wizard", () => openSetup());

  // Live-apply a captured hotkey (config window), no restart. Persistence is handled
  // separately by the config save; these just (re)register the global shortcut.
  ipcMain.handle("set-overlay-hotkey", (_e, accel) =>
    registerOverlayHotkey(typeof accel === "string" ? accel : ""));
  ipcMain.handle("set-binding-hotkey", (_e, accel) =>
    registerBindingHotkey(typeof accel === "string" ? accel : ""));
  ipcMain.handle("set-mining-hotkey", (_e, accel) =>
    registerMiningHotkey(typeof accel === "string" ? accel : ""));
  ipcMain.handle("set-webview-hotkey", (_e, accel) =>
    registerWebViewHotkey(typeof accel === "string" ? accel : ""));
  ipcMain.handle("set-interact-hotkey", (_e, accel) =>
    registerInteractHotkey(typeof accel === "string" ? accel : ""));
  ipcMain.handle("set-move-hotkey", (_e, accel) =>
    registerMoveHotkey(typeof accel === "string" ? accel : ""));
  ipcMain.handle("set-fabclaim-hotkey", (_e, accel) =>
    registerFabClaimHotkey(typeof accel === "string" ? accel : ""));
  ipcMain.handle("overlay:reset-layout", () => { resetWidgetLayout(); return true; });
  // Primary display's offset + size within the full-desktop canvas, so the page can default a
  // new/reset widget onto the PRIMARY monitor (not a corner of a left/top secondary display).
  ipcMain.handle("overlay:canvas-info", () => {
    const v = fullDisplayBounds();
    const p = screen.getPrimaryDisplay().bounds;
    return { px: p.x - v.x, py: p.y - v.y, pw: p.width, ph: p.height, vw: v.width, vh: v.height };
  });
  // Hold-to-interact opt-in: when off (default), the overlay is clickable whenever the cursor is
  // over a widget; when on, it's passive unless the interact key is held.
  ipcMain.handle("app:set-hold-mode", (_e, on) => { holdMode = !!on; foreground.want("hold", holdMode); applyMouse(); return holdMode; });
  // The canvas asks for foreground tracking only while its cog is actually up (see the cog
  // auto-hide in missions.html). Same opt-in contract as hold-to-interact: with the cog down and
  // hold off, the PowerShell helper isn't running at all. Answers immediately so a page that
  // arrives after the last change still learns the current state instead of waiting for the next.
  ipcMain.handle("app:want-foreground", (_e, on) => {
    foreground.want("cog", !!on);
    return foreground.ready() ? foreground.gameInFront() : null; // null = not known yet
  });

  // Legacy hover signal — hover is now driven by pollCursor() hit-testing the reported regions,
  // so this is a no-op (kept so the preload bridge / page calls don't error).
  ipcMain.on("overlay:hover", () => {});
  // The page reports its interactive elements' client-rects; pollCursor() hit-tests the cursor
  // against them to decide when this window is interactive (no mouse hook, no forwarding).
  ipcMain.on("overlay:regions", (_e, rects) => { overlayRegions = Array.isArray(rects) ? rects : []; });
  // A HUD modal (what's-new card / hub) opened/closed → keep it clickable even under lock.
  ipcMain.on("overlay:modal", (_e, on) => {
    modalOpen = !!on;
    // A modal (what's-new card, the hub) renders in the canvas and would be painted UNDER a
    // native view, so the view stands down while one is up.
    maskWebView(modalOpen);
    applyMouse();
  });
  // Notepad "typing mode" on/off. ON: bring the overlay foreground so the note field gets the
  // keyboard (no alt-tab), keep the notepad clickable without holding the interact key, and
  // suspend the interact key so it types as a letter. The field is focused only once a held
  // interact key is released (deferred here) so clicking "Type" while holding it drops no stray
  // character. OFF: back to normal click-through / hold-to-interact.
  ipcMain.on("overlay:notepad-editing", (_e, on) => {
    notepadEditing = !!on;
    applyMouse();
    if (notepadEditing) {
      if (overlay && !overlay.isDestroyed()) overlay.focus(); // foreground for keyboard input
      if (holdInteract) notepadFocusPending = true; // wait for the interact key to come up
      else { try { overlay && !overlay.isDestroyed() && overlay.webContents.send("overlay:notepad-focus"); } catch { /* ignore */ } }
    } else {
      notepadFocusPending = false;
    }
  });
  // An active drag/resize gesture on the HUD widget → force this window interactive for the
  // gesture so a fast pointer can't slip off the widget and drop the drag (the window is
  // otherwise click-through except over the widget, so the stacked mining canvas isn't blocked).
  ipcMain.on("overlay:drag-lock", (_e, on) => {
    dragging = !!on;
    // Star Citizen recentres the cursor while IT has focus, which yanks a drag out from under
    // you mid-gesture. We can't stop the game doing that — but it only does it while focused, so
    // taking focus for the duration of the gesture stops it. Entering arrange mode already does
    // this (setMoveMode); a corner-resize or a bar-drag outside arrange did not, which is where
    // it kept biting. Focus is not handed back: the user is mid-drag on the overlay, and the
    // notepad's typing mode has behaved this way since 0.1.33.
    if (dragging && overlay && !overlay.isDestroyed() && !overlay.isFocused()) overlay.focus();
    applyMouse();
  });
  // The cog's "Open settings…" opens the full config window.
  ipcMain.on("overlay:open-settings", () => openConfig());
  // The live-on-Twitch diamond opens the stream in the default browser (https only).
  ipcMain.on("overlay:open-url", (_e, url) => {
    if (typeof url === "string" && /^https:\/\//i.test(url)) shell.openExternal(url);
  });
  // Any widget's grab handle (or the global cog's Arrange button) enters GLOBAL arrange —
  // all visible widgets become movable; either "Done" exits for all.
  // Arrange draws drag banners and handles OVER the widgets; a native view would sit on top of
  // all of it, so it steps aside for the duration.
  ipcMain.on("overlay:begin-move", () => { maskWebView(true); setArrangeAll(true); });
  ipcMain.on("overlay:end-move", () => { maskWebView(false); setArrangeAll(false); });

  // ── the Web Page widget's view ──────────────────────────────────────────────
  // The renderer owns the widget's chrome and geometry and leaves a hole; these carry the hole's
  // rect, what to load in it, and whether it should be painted at all.
  ipcMain.on("webview:bounds", (_e, r) => {
    if (!r || typeof r.x !== "number") return;
    // Round: fractional bounds make a native view blurry against the game.
    webViewBounds = { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(0, Math.round(r.width)), height: Math.max(0, Math.round(r.height)) };
    applyWebViewBounds();
  });
  ipcMain.on("webview:show", (_e, on) => {
    webViewWanted = !!on;
    if (webViewWanted) ensureWebView();
    applyWebViewBounds();
  });
  ipcMain.on("webview:load", (_e, url) => {
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
    ensureWebView();
    webView?.webContents.loadURL(url).catch((e) => {
      try { overlay?.webContents.send("webview:state", { url, failed: String(e).split("\n")[0] }); } catch { /* gone */ }
    });
  });
  ipcMain.on("webview:reload", () => { try { webView?.webContents.reload(); } catch { /* none yet */ } });
  ipcMain.on("webview:back", () => {
    try { if (webView?.webContents.navigationHistory.canGoBack()) webView.webContents.navigationHistory.goBack(); } catch { /* none yet */ }
  });
  ipcMain.on("webview:close", () => { webViewWanted = false; destroyWebView(); });
  // Per-widget layout (canvas model): the page fetches saved widget layouts on load and
  // saves them back as the user drags/resizes. Scale is now a property of each widget inside
  // the full-screen canvas, not a resize of the overlay window (which is fixed full-screen).
  ipcMain.handle("overlay:get-widgets", () => readWidgets());
  ipcMain.on("overlay:save-widget", (_e, id, layout) => saveWidget(id, layout));

  // ── global widget on/off (from the in-overlay hub) ──────────────────────────
  // Only the Mining Assistant is a hub toggle — the Blueprint widget hides in-page and the
  // Binding chart is hotkey-only (never kept on). Both widgets now live in the one overlay
  // renderer, so mining is a shell-owned visibility flag (setMiningVisible) rather than a window.
  // (sendMiningVisible / pushWidgetStates / setMiningVisible are defined at module scope above.)
  ipcMain.handle("app:widget-states", () => ({ mining: miningVisible, notepad: notepadVisible, twitchChat: twitchChatVisible, scFeed: scFeedVisible, unlockAlert: unlockAlertVisible, party: partyVisible, battaglia: battagliaVisible, webView: webViewVisible, bindingChart: bindingChartVisible, config: configWidgetVisible }));
  ipcMain.on("app:set-mining", (_e, on) => {
    if (on) { miningAutoSuppress = 0; setMiningVisible(true); }
    else setMiningVisible(false, { manual: true });
  });
  ipcMain.on("app:set-notepad", (_e, on) => setNotepadVisible(!!on));
  ipcMain.on("app:set-twitchchat", (_e, on) => setTwitchChatVisible(!!on));
  ipcMain.on("app:set-scfeed", (_e, on) => setScFeedVisible(!!on));
  ipcMain.on("app:set-unlockalert", (_e, on) => setUnlockAlertVisible(!!on));
  ipcMain.on("app:set-party", (_e, on) => setPartyVisible(!!on));
  ipcMain.on("app:set-battaglia", (_e, on) => setBattagliaVisible(!!on));
  ipcMain.on("app:set-config", (_e, on) => setConfigWidgetVisible(!!on));
  // SC Feed alert tone picker, mirroring mining:pick-tone (renderers can't open OS dialogs).
  ipcMain.handle("scfeed:pick-tone", async () => {
    const r = await dialog.showOpenDialog(overlay ?? undefined, {
      title: "Choose an SC Feed alert WAV",
      filters: [{ name: "WAV audio", extensions: ["wav"] }],
      properties: ["openFile"],
    });
    if (r.canceled || !r.filePaths.length) return false;
    await postConfig({ scFeedTone: r.filePaths[0] });
    return true;
  });
  ipcMain.handle("scfeed:clear-tone", async () => { await postConfig({ scFeedTone: "" }); return true; });
  ipcMain.on("app:set-webview", (_e, on) => setWebViewVisible(!!on));
  ipcMain.on("app:set-bindingchart", (_e, on) => setBindingChartVisible(!!on));
  // Reveal one of our own data folders in Explorer (the Party widget's saved splits). Restricted
  // to a known allow-list of subfolders so a renderer can never ask the shell to open a path.
  // Performance readout: Electron's own per-process CPU + memory, so "how much is this costing
  // my PC" is answerable in the app instead of via Task Manager guesswork.
  ipcMain.handle("app:metrics", () => {
    const os = require("node:os");
    let cpu = 0, mem = 0;
    const rows = [];
    for (const m of app.getAppMetrics()) {
      const mb = Math.round((m.memory?.workingSetSize ?? 0) / 1024);
      // Electron reports CPU as a share of ONE core.
      const pc = m.cpu?.percentCPUUsage ?? 0;
      cpu += pc; mem += mb;
      rows.push({ type: m.type, mb, pc });
    }
    rows.sort((a, b) => b.mb - a.mb);
    const cores = os.cpus().length;
    return {
      totalMb: mem,
      // Share of the WHOLE cpu, which is what a player cares about.
      cpuPct: Math.round((cpu / cores) * 10) / 10,
      cores,
      // Total installed RAM, so every memory figure can be expressed as a share of the SYSTEM
      // rather than a share of our own usage (which says nothing about impact).
      systemMb: Math.round(os.totalmem() / 1048576),
      rows,
    };
  });
  ipcMain.on("app:open-data-folder", (_e, which) => {
    const dirs = { "party-sessions": "party-sessions", "fab-captures": "fab-captures" };
    const sub = dirs[String(which)];
    if (!sub) return;
    const dir = path.join(process.env.APPDATA || process.env.HOME || ".", "sc-blueprint-tracker", sub);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
    shell.openPath(dir);
  });

  // Tray app — keep running when the overlay window is closed.
  app.on("window-all-closed", (e) => {
    e.preventDefault?.();
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
    hotkeys.unregisterAll();
    foreground.stop(); // a piped child would otherwise outlive us
    if (serverRestartTimer) clearTimeout(serverRestartTimer); // don't respawn one on the way out
    if (server) server.kill();
    if (tray) tray.destroy();
  });
}

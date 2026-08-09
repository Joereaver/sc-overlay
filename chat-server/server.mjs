// SC Overlay chat server — option 1 of the A/B (custom, self-hosted, zero deps beyond `ws`).
//
// PROTOTYPE HOME: this lives in the app repo for the A/B test; its production home is the
// subliminal-gg stack (same VPS as the auth it needs). Everything user-facing goes through
// the sidecar (src/chat.ts) — widgets never talk to this server directly.
//
// The channel model is Sub's EVE-style hierarchy (2026-08-08):
//   global                       everyone using the app
//   region:<use1b>               same region/AZ — what players call "the server"
//   shard:<pub_use1b_..._040>    same universe instance — the people you can actually meet
// The client is TRUSTED about its own location (it read it from its own Game.log; lying gets
// you into a channel where nobody can meet you, which punishes only the liar).
//
// Identity: chat requires an RSI-VERIFIED account (Sub's rule — bannable identities).
//   CHAT_AUTH=dev   (default) hello.handle is accepted as-is, verified=true. LOCAL A/B ONLY.
//   CHAT_AUTH=site  hello.token is resolved via subliminal.gg (CHAT_AUTH_URL) into
//                   { handle, verified } — the production mode; endpoint lands with the
//                   site-side work, shape documented at verifyIdentity().
//
// Channel kinds (v2, 2026-08-09 — EVE-structured widget):
//   AUTO    global · region:<use1b> · shard:<full id>   follow the Game.log, never chosen
//   ORG     org:<sid>                                   auto-joined from the VERIFIED org on the
//                                                       RSI dossier (site auth carries it)
//   CUSTOM  custom:<slug>                               user-created rooms; join/create/leave;
//                                                       a public directory lists them
//
// Wire protocol (JSON text frames over /ws). v1 clients (0.1.41) only ever send hello/loc/msg
// and ignore unknown frames, so everything added here is backward compatible.
//   c→s  {t:"hello", token?, handle?, org?}    auth; nothing else is accepted before it
//        {t:"loc", region?, shard?}            current location (null/absent = leave)
//        {t:"msg", ch, text}                   say something
//        {t:"join", name, mode?}               custom room by display name; mode "join" errors
//                                              if absent, "create" errors if taken, default
//                                              join-or-create
//        {t:"leave", ch}                       custom rooms only (auto/org follow identity)
//   s→c  {t:"welcome", you:{handle,verified}}  hello accepted
//        {t:"joined", ch, label?, kind?}       membership changes (always server-initiated)
//        {t:"left", ch}
//        {t:"history", ch, msgs:[Msg]}         last messages, sent right after joined
//        {t:"msg", ...Msg}                     live message (Msg = {ch,id,from,text,at})
//        {t:"presence", ch, count, members}    unique handles in the room, debounced;
//                                              members = [{handle,verified}] capped at 200
//        {t:"dir", channels}                   the custom-room directory [{ch,label,count}],
//                                              sent on welcome + debounced on change
//        {t:"error", code, message}            bad_auth | banned | not_member | rate | bad_msg
//                                              | bad_channel | no_such_channel | channel_exists

import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.CHAT_PORT) || 8788;
const AUTH_MODE = process.env.CHAT_AUTH === "site" ? "site" : "dev";
const AUTH_URL = process.env.CHAT_AUTH_URL || "https://subliminal.gg/api/sc/chat-auth";
const HISTORY_KEEP = 200;   // ring size per room
const HISTORY_SEND = 50;    // sent on join
const MSG_MAX = 400;        // chars
const RATE_N = 5, RATE_WINDOW_MS = 10_000; // msgs per window per connection

// CHAT_DATA_DIR: tests point this at a scratch dir so their bans/rooms never touch real state.
const dataDir = process.env.CHAT_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), "data");
const bansPath = join(dataDir, "bans.json");
const channelsPath = join(dataDir, "channels.json");
const MEMBERS_CAP = 200;        // handles listed per presence frame (count is always exact)
const CUSTOM_IDLE_PRUNE_MS = 14 * 24 * 3600 * 1000; // empty custom rooms older than this drop

// ── Bans — lowercase handles. The whole point of the RSI-verify gate is that these stick. ──
let bans = new Set();
try { bans = new Set(JSON.parse(readFileSync(bansPath, "utf8")).map((h) => String(h).toLowerCase())); }
catch { /* no bans file yet */ }
function saveBans() {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(bansPath, JSON.stringify([...bans], null, 2));
}

// ── Custom-room directory — survives restarts so a created room is a durable place. ──
/** slug → { label, created, lastActive } (all customs are public; key = "custom:"+slug). */
let customDir = new Map();
try {
  const raw = JSON.parse(readFileSync(channelsPath, "utf8"));
  customDir = new Map(Object.entries(raw));
} catch { /* no channels file yet */ }
function saveChannels() {
  // Prune long-empty rooms on the way out so the directory can't grow forever.
  const now = Date.now();
  for (const [slug, meta] of customDir) {
    const empty = (rooms.get(`custom:${slug}`)?.members.size ?? 0) === 0;
    if (empty && now - (meta.lastActive ?? meta.created ?? now) > CUSTOM_IDLE_PRUNE_MS) customDir.delete(slug);
  }
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(channelsPath, JSON.stringify(Object.fromEntries(customDir), null, 2));
}
/** Display name → slug. The slug is the identity; the label keeps the user's casing. */
function slugOfName(name) {
  const s = String(name ?? "").trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "");
  return /^[a-z0-9][a-z0-9._-]{2,29}$/.test(s) ? s : null;
}
function dirPayload() {
  return [...customDir.entries()].map(([slug, meta]) => ({
    ch: `custom:${slug}`,
    label: meta.label,
    count: new Set([...(rooms.get(`custom:${slug}`)?.members ?? [])].map((c) => c.handleLower)).size,
  }));
}
let dirTimer = null;
function broadcastDir() {
  if (dirTimer) return;
  dirTimer = setTimeout(() => {
    dirTimer = null;
    const frame = JSON.stringify({ t: "dir", channels: dirPayload() });
    for (const c of conns) if (c.handle && c.ws.readyState === 1) c.ws.send(frame);
  }, 500);
}

// ── Rooms ───────────────────────────────────────────────────────────────────
/** ch → { members:Set<conn>, history:Msg[], nextId, presenceTimer } */
const rooms = new Map();
function room(ch) {
  let r = rooms.get(ch);
  if (!r) { r = { members: new Set(), history: [], nextId: 1, presenceTimer: null }; rooms.set(ch, r); }
  return r;
}
function roomSend(ch, frame) {
  const r = rooms.get(ch);
  if (!r) return;
  const text = JSON.stringify(frame);
  for (const c of r.members) if (c.ws.readyState === 1) c.ws.send(text);
}
function presence(ch) {
  const r = rooms.get(ch);
  if (!r || r.presenceTimer) return;
  r.presenceTimer = setTimeout(() => {
    r.presenceTimer = null;
    // One row per HANDLE (a second window isn't a second person), capped for frame size —
    // the count stays exact past the cap.
    const seen = new Map();
    for (const c of r.members) if (!seen.has(c.handleLower)) seen.set(c.handleLower, { handle: c.handle, verified: c.verified });
    roomSend(ch, { t: "presence", ch, count: seen.size, members: [...seen.values()].slice(0, MEMBERS_CAP) });
    if (ch.startsWith("custom:")) broadcastDir();
  }, 250);
}
/** Label + kind ride the joined frame for rooms the CLIENT can't derive (org names, custom
 *  display casing). Auto channels send neither; the client's own labels are already right. */
function joinRoom(conn, ch, label, kind) {
  if (conn.channels.has(ch)) return;
  const r = room(ch);
  r.members.add(conn);
  conn.channels.add(ch);
  conn.send({ t: "joined", ch, ...(label ? { label } : {}), ...(kind ? { kind } : {}) });
  conn.send({ t: "history", ch, msgs: r.history.slice(-HISTORY_SEND) });
  presence(ch);
}
function leaveRoom(conn, ch) {
  if (!conn.channels.has(ch)) return;
  conn.channels.delete(ch);
  const r = rooms.get(ch);
  if (r) {
    r.members.delete(conn);
    // An empty region/shard room is garbage — shards churn every patch day. Global persists,
    // and CUSTOM rooms keep their object (and scrollback) while their directory entry lives;
    // the idle prune in saveChannels() is what finally retires them.
    if (r.members.size === 0 && (ch.startsWith("region:") || ch.startsWith("shard:"))) rooms.delete(ch);
    else presence(ch);
  }
  if (ch.startsWith("custom:")) {
    const meta = customDir.get(ch.slice("custom:".length));
    if (meta) meta.lastActive = Date.now();
    broadcastDir();
  }
  conn.send({ t: "left", ch });
}

// ── Identity ────────────────────────────────────────────────────────────────
const HANDLE_RE = /^[A-Za-z0-9._-]{3,30}$/; // RSI handle shape
const ORG_SID_RE = /^[A-Za-z0-9]{3,12}$/; // RSI org SIDs (e.g. IRREGS)
async function verifyIdentity(hello) {
  if (AUTH_MODE === "dev") {
    const handle = String(hello.handle ?? "").trim();
    if (!HANDLE_RE.test(handle)) return null;
    // Dev passthrough for org testing: hello.org = {sid, name}.
    const sid = String(hello.org?.sid ?? "");
    const org = ORG_SID_RE.test(sid) ? { sid, name: String(hello.org?.name ?? sid).slice(0, 60) } : null;
    return { handle, verified: true, org };
  }
  // site mode: the token is the overlay's existing sync token; the endpoint answers
  // { handle: "RSIHandle", verified: true|false } and 401s an unknown token. A KNOWN
  // token with no verified handle is a distinct case — the user needs to hear "go
  // verify", not "who are you".
  const token = String(hello.token ?? "");
  if (!token) return null;
  try {
    const res = await fetch(AUTH_URL, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const d = await res.json();
    const handle = String(d?.handle ?? "");
    if (d?.verified !== true || !HANDLE_RE.test(handle)) return { handle: "", verified: false };
    // The verified org from the RSI dossier (captured at handle-verification time) drives the
    // org channel. Absent/redacted org just means no org room — never a refusal.
    const sid = String(d?.orgSid ?? "");
    const org = ORG_SID_RE.test(sid) ? { sid, name: String(d?.orgName ?? sid).slice(0, 60) } : null;
    return { handle, verified: true, org };
  } catch { return null; }
}

// ── Location → channel names. Validate hard: these strings come from clients. ──
const REGION_RE = /^[a-z0-9]{3,12}$/;
const SHARD_RE = /^[a-z0-9][a-z0-9_-]{4,63}$/i;
function locChannels(loc) {
  const out = [];
  const region = typeof loc.region === "string" ? loc.region.toLowerCase() : "";
  const shard = typeof loc.shard === "string" ? loc.shard : "";
  if (REGION_RE.test(region)) out.push(`region:${region}`);
  if (SHARD_RE.test(shard) && shard !== "local_shard") out.push(`shard:${shard.toLowerCase()}`);
  return out;
}

// ── HTTP (health + loopback admin) ──────────────────────────────────────────
const loopback = (req) => {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
};
function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => { s += c; if (s.length > 4096) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(s)); } catch { resolve({}); } });
  });
}
const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  if (url === "/health") {
    const roomStats = {};
    for (const [ch, r] of rooms) roomStats[ch] = r.members.size;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, mode: AUTH_MODE, connections: wss.clients.size, rooms: roomStats }));
    return;
  }
  // Ban admin is loopback-only — same rule as the sidecar's /api/twitch/*: an endpoint
  // that ACTS with authority IS the authority, so it must not answer the LAN.
  if (url.startsWith("/admin/") && !loopback(req)) { res.writeHead(403); res.end(); return; }
  if (url === "/admin/bans" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([...bans]));
    return;
  }
  if ((url === "/admin/ban" || url === "/admin/unban") && req.method === "POST") {
    const handle = String((await readBody(req)).handle ?? "").toLowerCase();
    if (!HANDLE_RE.test(handle)) { res.writeHead(400); res.end(); return; }
    if (url === "/admin/ban") {
      bans.add(handle);
      for (const c of conns) if (c.handleLower === handle) { c.send({ t: "error", code: "banned", message: "You have been banned." }); c.ws.close(); }
    } else bans.delete(handle);
    saveBans();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, bans: bans.size }));
    return;
  }
  res.writeHead(404); res.end();
});

// ── WebSocket ───────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/ws" });
const conns = new Set();
let nextMsgId = 1;

wss.on("connection", (ws) => {
  const conn = {
    ws,
    handle: null, handleLower: null, verified: false,
    channels: new Set(),
    stamps: [], // send timestamps for the rate limit
    alive: true,
    send(frame) { if (ws.readyState === 1) ws.send(JSON.stringify(frame)); },
  };
  conns.add(conn);
  ws.on("pong", () => { conn.alive = true; });

  ws.on("message", async (raw) => {
    let f;
    try { f = JSON.parse(String(raw)); } catch { return; }
    if (!f || typeof f !== "object") return;

    if (f.t === "hello" && !conn.handle) {
      const id = await verifyIdentity(f);
      if (!id) { conn.send({ t: "error", code: "bad_auth", message: "Could not verify your account." }); ws.close(); return; }
      // The gate: no verified RSI account, no chat. (dev mode returns verified=true.)
      if (!id.verified) { conn.send({ t: "error", code: "bad_auth", message: "Verify your RSI account on subliminal.gg to use chat." }); ws.close(); return; }
      if (bans.has(id.handle.toLowerCase())) { conn.send({ t: "error", code: "banned", message: "You have been banned." }); ws.close(); return; }
      conn.handle = id.handle;
      conn.handleLower = id.handle.toLowerCase();
      conn.verified = id.verified;
      conn.send({ t: "welcome", you: { handle: conn.handle, verified: conn.verified } });
      joinRoom(conn, "global");
      // Verified org → its room, automatically. No setup, no invite — membership on the RSI
      // dossier IS the invite.
      if (id.org) joinRoom(conn, `org:${id.org.sid.toLowerCase()}`, id.org.name, "org");
      conn.send({ t: "dir", channels: dirPayload() });
      return;
    }
    if (!conn.handle) return; // nothing but hello before auth

    if (f.t === "loc") {
      const want = new Set(locChannels(f));
      // Only the AUTO location channels churn with the log — global/org/custom stay put.
      for (const ch of [...conn.channels])
        if ((ch.startsWith("region:") || ch.startsWith("shard:")) && !want.has(ch)) leaveRoom(conn, ch);
      for (const ch of want) joinRoom(conn, ch);
      return;
    }

    // Custom rooms: join-or-create by display name (mode narrows it: "join" = must exist,
    // "create" = must not).
    if (f.t === "join") {
      const label = String(f.name ?? "").trim().slice(0, 30);
      const slug = slugOfName(label);
      if (!slug) { conn.send({ t: "error", code: "bad_channel", message: "Channel names are 3–30 letters, numbers, spaces or -._" }); return; }
      const exists = customDir.has(slug);
      if (f.mode === "join" && !exists) { conn.send({ t: "error", code: "no_such_channel", message: `No channel called “${label}”.` }); return; }
      if (f.mode === "create" && exists) { conn.send({ t: "error", code: "channel_exists", message: `“${customDir.get(slug).label}” already exists — join it instead.` }); return; }
      if (!exists) {
        customDir.set(slug, { label, created: Date.now(), lastActive: Date.now() });
        saveChannels();
        broadcastDir();
      }
      joinRoom(conn, `custom:${slug}`, customDir.get(slug).label, "custom");
      return;
    }

    if (f.t === "leave") {
      const ch = String(f.ch ?? "");
      // Only custom rooms are leavable — auto channels follow the log, the org room follows
      // the dossier. (Muting those is a CLIENT affordance, not membership.)
      if (!ch.startsWith("custom:")) { conn.send({ t: "error", code: "bad_channel", message: "Only custom channels can be left." }); return; }
      leaveRoom(conn, ch);
      return;
    }

    if (f.t === "msg") {
      const ch = String(f.ch ?? "");
      if (!conn.channels.has(ch)) { conn.send({ t: "error", code: "not_member", message: "Not in that channel." }); return; }
      const now = Date.now();
      conn.stamps = conn.stamps.filter((s) => now - s < RATE_WINDOW_MS);
      if (conn.stamps.length >= RATE_N) { conn.send({ t: "error", code: "rate", message: "Slow down a little." }); return; }
      // Strip control chars; the widget renders via textContent so markup is inert anyway.
      // 🔑 Truncate by CODE POINT, not by .slice(): an emoji is a surrogate PAIR, and slicing
      // between its halves emits a lone surrogate — the black-diamond "�" every client would
      // then render, from a message that was perfectly valid when sent.
      const cleaned = String(f.text ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
      const text = [...cleaned].slice(0, MSG_MAX).join("");
      if (!text) { conn.send({ t: "error", code: "bad_msg", message: "Empty message." }); return; }
      conn.stamps.push(now);
      const msg = { ch, id: nextMsgId++, from: { handle: conn.handle, verified: conn.verified }, text, at: new Date().toISOString() };
      const r = room(ch);
      r.history.push(msg);
      if (r.history.length > HISTORY_KEEP) r.history.splice(0, r.history.length - HISTORY_KEEP);
      roomSend(ch, { t: "msg", ...msg });
      return;
    }
  });

  ws.on("close", () => {
    conns.delete(conn);
    for (const ch of [...conn.channels]) {
      conn.channels.delete(ch);
      const r = rooms.get(ch);
      if (r) {
        r.members.delete(conn);
        if (r.members.size === 0 && (ch.startsWith("region:") || ch.startsWith("shard:"))) rooms.delete(ch);
        else presence(ch);
      }
      if (ch.startsWith("custom:")) {
        const meta = customDir.get(ch.slice("custom:".length));
        if (meta) meta.lastActive = Date.now();
        broadcastDir();
      }
    }
  });
});

// Reap dead connections (a yanked network cable never sends close).
setInterval(() => {
  for (const c of conns) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch { /* closing */ }
  }
}, 30_000);

server.listen(PORT, () => {
  console.log(`[chat-server] listening on :${PORT} (auth=${AUTH_MODE}, bans=${bans.size})`);
});

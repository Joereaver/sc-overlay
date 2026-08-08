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
// Wire protocol (JSON text frames over /ws):
//   c→s  {t:"hello", token?, handle?}          auth; nothing else is accepted before it
//        {t:"loc", region?, shard?}            current location (null/absent = leave)
//        {t:"msg", ch, text}                   say something
//   s→c  {t:"welcome", you:{handle,verified}}  hello accepted
//        {t:"joined", ch} {t:"left", ch}       membership changes (always server-initiated)
//        {t:"history", ch, msgs:[Msg]}         last messages, sent right after joined
//        {t:"msg", ...Msg}                     live message (Msg = {ch,id,from,text,at})
//        {t:"presence", ch, count}             unique handles in the room, debounced
//        {t:"error", code, message}            bad_auth | banned | not_member | rate | bad_msg

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

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "data");
const bansPath = join(dataDir, "bans.json");

// ── Bans — lowercase handles. The whole point of the RSI-verify gate is that these stick. ──
let bans = new Set();
try { bans = new Set(JSON.parse(readFileSync(bansPath, "utf8")).map((h) => String(h).toLowerCase())); }
catch { /* no bans file yet */ }
function saveBans() {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(bansPath, JSON.stringify([...bans], null, 2));
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
    const handles = new Set([...r.members].map((c) => c.handleLower));
    roomSend(ch, { t: "presence", ch, count: handles.size });
  }, 250);
}
function joinRoom(conn, ch) {
  if (conn.channels.has(ch)) return;
  const r = room(ch);
  r.members.add(conn);
  conn.channels.add(ch);
  conn.send({ t: "joined", ch });
  conn.send({ t: "history", ch, msgs: r.history.slice(-HISTORY_SEND) });
  presence(ch);
}
function leaveRoom(conn, ch) {
  if (!conn.channels.has(ch)) return;
  conn.channels.delete(ch);
  const r = rooms.get(ch);
  if (r) {
    r.members.delete(conn);
    // An empty region/shard room is garbage — shards churn every patch day. Global persists.
    if (r.members.size === 0 && ch !== "global") rooms.delete(ch);
    else presence(ch);
  }
  conn.send({ t: "left", ch });
}

// ── Identity ────────────────────────────────────────────────────────────────
const HANDLE_RE = /^[A-Za-z0-9._-]{3,30}$/; // RSI handle shape
async function verifyIdentity(hello) {
  if (AUTH_MODE === "dev") {
    const handle = String(hello.handle ?? "").trim();
    if (!HANDLE_RE.test(handle)) return null;
    return { handle, verified: true };
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
    return { handle, verified: true };
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
      return;
    }
    if (!conn.handle) return; // nothing but hello before auth

    if (f.t === "loc") {
      const want = new Set(locChannels(f));
      for (const ch of [...conn.channels]) if (ch !== "global" && !want.has(ch)) leaveRoom(conn, ch);
      for (const ch of want) joinRoom(conn, ch);
      return;
    }

    if (f.t === "msg") {
      const ch = String(f.ch ?? "");
      if (!conn.channels.has(ch)) { conn.send({ t: "error", code: "not_member", message: "Not in that channel." }); return; }
      const now = Date.now();
      conn.stamps = conn.stamps.filter((s) => now - s < RATE_WINDOW_MS);
      if (conn.stamps.length >= RATE_N) { conn.send({ t: "error", code: "rate", message: "Slow down a little." }); return; }
      // Strip control chars; the widget renders via textContent so markup is inert anyway.
      const text = String(f.text ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, MSG_MAX);
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
        if (r.members.size === 0 && ch !== "global") rooms.delete(ch);
        else presence(ch);
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

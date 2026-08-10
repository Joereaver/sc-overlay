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
//        {t:"join", name, mode?,               custom room by display name OR join code; mode
//               category?, privacy?}           "join" errors if absent, "create" errors if
//                                              taken, default join-or-create. category/privacy
//                                              apply only when CREATING.
//        {t:"invite", ch, handle}              owner only; admits a handle to a private room
//        {t:"dm", to, text}                    private message to one handle
//        {t:"dmlist"}                          ask for this handle's conversations
//        {t:"leave", ch}                       custom rooms + DMs (auto/org follow identity)
//   s→c  {t:"welcome", you:{...}, categories}  hello accepted; categories = the activity list
//        {t:"joined", ch, label?, kind?}       membership changes (always server-initiated)
//        {t:"roominfo", ch, category,          the room you just joined; `code` ONLY for a
//               privacy, owner, code?}         private room you are inside
//        {t:"invited", ch, handle}             your invite was recorded
//        {t:"roominvite", ch, label,           someone invited YOU (only if you're online;
//               category, from}                otherwise the invite just waits)
//        {t:"left", ch}
//        {t:"history", ch, msgs:[Msg]}         last messages, follows joined
//        {t:"msg", ...Msg}                     live message (Msg = {ch,id,from,text,at})
//        {t:"presence", ch, count, members}    unique handles in the room, debounced;
//                                              members = [{handle,verified}] capped at 200
//        {t:"dir", channels}                   the PUBLIC custom-room directory
//                                              [{ch,label,category,count}], on welcome +
//                                              debounced on change. Private rooms are absent.
//        {t:"dms", threads}                    [{other, lastAt}], newest first
//        {t:"error", code, message}            bad_auth | banned | not_member | rate | bad_msg
//                                              | bad_channel | no_such_channel | channel_exists
//                                              | not_invited | not_owner | bad_handle

import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { createStore, dmKey } from "./store.mjs";

const PORT = Number(process.env.CHAT_PORT) || 8788;
const AUTH_MODE = process.env.CHAT_AUTH === "site" ? "site" : "dev";
const AUTH_URL = process.env.CHAT_AUTH_URL || "https://subliminal.gg/api/sc/chat-auth";
const HISTORY_KEEP = 200;   // ring size per room
const HISTORY_SEND = 50;    // sent on join
const MSG_MAX = 400;        // chars
const RATE_N = 5, RATE_WINDOW_MS = 10_000; // msgs per window per connection
// Access ATTEMPTS (join / dm / invite / delete) get their own, tighter budget. A legitimate
// client sends a handful of joins on connect and then almost none; a code-guesser sends
// thousands. 12 per 30s is far above real use and far below useful brute force.
const ACT_N = 12, ACT_WINDOW_MS = 30_000;

// CHAT_DATA_DIR: tests point this at a scratch dir so their bans/rooms never touch real state.
const dataDir = process.env.CHAT_DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), "data");
const MEMBERS_CAP = 200;        // handles listed per presence frame (count is always exact)
const CUSTOM_IDLE_PRUNE_MS = 14 * 24 * 3600 * 1000; // empty custom rooms older than this drop
const PRUNE_EVERY_MS = 3600_000;

// ── Persistence ─────────────────────────────────────────────────────────────
// With DATABASE_URL set this is Postgres; without it, JSON files and memory-only scrollback
// (which is what keeps the test suite hermetic). See store.mjs.
const store = createStore({ dataDir, databaseUrl: process.env.DATABASE_URL, log: console });
const loaded = await store.init();

/** Bans — lowercase handles. The whole point of the RSI-verify gate is that these stick. */
const bans = loaded.bans;
/** slug → { label, category, privacy, code, owner, created, lastActive, invites } */
const customDir = loaded.rooms;
let nextMsgId = loaded.maxMessageId + 1;

/** A room is "active" whenever someone speaks in it or its membership changes — that timestamp
 *  is the only thing standing between the directory and unbounded growth. */
function touchRoom(slug) {
  const meta = customDir.get(slug);
  if (!meta) return;
  meta.lastActive = Date.now();
  store.touchRoom(slug, meta.lastActive);
}

/** Retire rooms nobody has been in for a fortnight, so the directory can't grow forever.
 *  🔑 This used to ride along inside the save function, which meant it only ever ran when
 *  something ELSE changed — a directory that stopped changing also stopped being pruned. */
function pruneIdleRooms() {
  const now = Date.now();
  for (const [slug, meta] of customDir) {
    const empty = (rooms.get(`custom:${slug}`)?.members.size ?? 0) === 0;
    if (empty && now - (meta.lastActive ?? meta.created ?? now) > CUSTOM_IDLE_PRUNE_MS) {
      customDir.delete(slug);
      store.deleteRoom(slug);
    }
  }
}
// ── Activity categories ─────────────────────────────────────────────────────
// What kind of gameplay a room is for, so the directory groups by what people are DOING rather
// than being one flat list of names (Sub, 2026-08-09). The server owns this list and ships it in
// the welcome frame — the widget's dropdown is rendered from it, so adding a category here is
// the whole change, with no client release needed.
// 🔑 The SLUG is what's stored; labels are free to be reworded. Never renumber or reuse a slug.
const ROOM_CATEGORIES = [
  { slug: "org-ops",   label: "Org Operations" },
  { slug: "ship-pvp",  label: "Ship Combat / PvP" },
  { slug: "fps",       label: "FPS / Ground Combat" },
  { slug: "bounty",    label: "Bounty Hunting" },
  { slug: "mining",    label: "Mining" },
  { slug: "salvage",   label: "Salvage" },
  { slug: "hauling",   label: "Hauling & Trading" },
  { slug: "explore",   label: "Exploration" },
  { slug: "medical",   label: "Medical & Rescue" },
  { slug: "racing",    label: "Racing" },
  { slug: "events",    label: "Events" },
  { slug: "social",    label: "Social / Other" },
];
const CATEGORY_SLUGS = new Set(ROOM_CATEGORIES.map((c) => c.slug));
// Rooms created before categories existed land here rather than being refused — "Social / Other"
// is the honest answer for a room whose creator was never asked.
const DEFAULT_CATEGORY = "social";

// ── Join codes ──────────────────────────────────────────────────────────────
// A private room is reached two ways: this code, or an invite from the owner. The alphabet drops
// O/0/I/1 — a code is read off Discord and typed by hand, and those are the pairs people get
// wrong. Stored and compared uppercase, so "k7m2qd" works.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN = 6;
function makeCode() {
  const taken = new Set([...customDir.values()].map((m) => m.code).filter(Boolean));
  for (let tries = 0; tries < 50; tries++) {
    let s = "";
    for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (!taken.has(s)) return s;
  }
  return null;   // 32^6 codes against a handful of rooms — this is a bug, not bad luck
}
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`, "i");
/** Find a private room by its join code. */
function roomByCode(code) {
  const up = String(code).toUpperCase();
  for (const [slug, meta] of customDir) if (meta.code && meta.code === up) return { slug, meta };
  return null;
}
/** May this connection enter this room? Public rooms are open; a private one needs the code,
 *  an invite, or ownership. Redeeming a code records an invite (see the join handler), so
 *  after the first entry the invite list is the single answer to "who is allowed in here". */
function mayJoin(conn, meta, typed) {
  if (meta.privacy !== "private") return true;
  if (meta.owner && meta.owner === conn.handleLower) return true;
  if (meta.invites?.includes(conn.handleLower)) return true;
  return !!(meta.code && typed && String(typed).toUpperCase() === meta.code);
}

/** Display name → slug. The slug is the identity; the label keeps the user's casing. */
function slugOfName(name) {
  const s = String(name ?? "").trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9._-]/g, "");
  return /^[a-z0-9][a-z0-9._-]{2,29}$/.test(s) ? s : null;
}
/** The public directory. 🔑 PRIVATE ROOMS ARE NEVER IN IT — not filtered on the client, absent
 *  from the frame. A room you can see the name and headcount of is not private, and the whole
 *  reason private rooms exist is that creating one used to publish it to everybody. */
function dirPayload() {
  const out = [];
  for (const [slug, meta] of customDir) {
    if (meta.privacy === "private") continue;
    out.push({
      ch: `custom:${slug}`,
      label: meta.label,
      category: meta.category ?? DEFAULT_CATEGORY,
      count: new Set([...(rooms.get(`custom:${slug}`)?.members ?? [])].map((c) => c.handleLower)).size,
    });
  }
  return out;
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
  if (!r) { r = { members: new Set(), history: [], nextId: 1, presenceTimer: null, hydrated: false }; rooms.set(ch, r); }
  return r;
}
/** Pull a cold room's scrollback out of the store, once.
 *
 *  🔑 The in-memory ring stays the source of truth for LIVE sends — this only fills it the
 *  first time a room is touched after a restart. Concurrent joiners share one query via the
 *  stored promise, or ten people reconnecting after a redeploy each run their own. */
function hydrate(ch) {
  const r = room(ch);
  if (r.hydrated) return Promise.resolve(r);
  if (!r.hydrating) {
    r.hydrating = store.loadHistory(ch, HISTORY_KEEP)
      .then((msgs) => {
        // Anything said WHILE the load was in flight is already in the ring and is newer than
        // anything the query saw, so the loaded rows go in front of it rather than replacing it.
        const live = r.history;
        r.history = msgs.concat(live.filter((m) => !msgs.some((h) => h.id === m.id)));
        if (r.history.length > HISTORY_KEEP) r.history.splice(0, r.history.length - HISTORY_KEEP);
        r.hydrated = true;
        return r;
      })
      .catch((e) => { console.error("[chat] history load failed for", ch, e?.message); r.hydrated = true; return r; });
  }
  return r.hydrating;
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
  // `joined` goes out immediately so the channel appears at once; `history` follows when the
  // store answers. They were always separate frames, and the client appends rather than
  // waiting on the pair, so a cold room costs a beat of empty scrollback and nothing else.
  conn.send({ t: "joined", ch, ...(label ? { label } : {}), ...(kind ? { kind } : {}) });
  hydrate(ch).then((h) => {
    if (conn.channels.has(ch)) conn.send({ t: "history", ch, msgs: h.history.slice(-HISTORY_SEND) });
  });
  presence(ch);
}
/** Validate, record and broadcast one message into a room the sender is already in.
 *  Returns the message, or null if it was refused (the refusal is already sent).
 *  🔑 Channel messages and DMs both come through here — the rate limit, the control-char strip
 *  and the code-point truncation are rules about MESSAGES, not about channels, and a second
 *  copy of them is a second place for them to drift. */
function deliver(conn, ch, raw) {
  const now = Date.now();
  conn.stamps = conn.stamps.filter((s) => now - s < RATE_WINDOW_MS);
  if (conn.stamps.length >= RATE_N) { conn.send({ t: "error", code: "rate", message: "Slow down a little." }); return null; }
  // Strip control chars; the widget renders via textContent so markup is inert anyway.
  // 🔑 Truncate by CODE POINT, not by .slice(): an emoji is a surrogate PAIR, and slicing
  // between its halves emits a lone surrogate — the black-diamond "�" every client would
  // then render, from a message that was perfectly valid when sent.
  const cleaned = String(raw ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
  const text = [...cleaned].slice(0, MSG_MAX).join("");
  if (!text) { conn.send({ t: "error", code: "bad_msg", message: "Empty message." }); return null; }
  conn.stamps.push(now);
  const msg = { ch, id: nextMsgId++, from: { handle: conn.handle, verified: conn.verified }, text, at: new Date().toISOString() };
  const r = room(ch);
  r.history.push(msg);
  if (r.history.length > HISTORY_KEEP) r.history.splice(0, r.history.length - HISTORY_KEEP);
  // Broadcast FIRST, persist behind it — the store is never allowed to delay a live message.
  roomSend(ch, { t: "msg", ...msg });
  store.saveMessage(msg);
  return msg;
}

/** Wipe a custom room: evict everyone, drop it from the directory, delete it and its messages.
 *  Used by the owner's delete and by the loopback admin route, so both paths behave identically
 *  — a moderator deleting a room and an owner deleting one must not leave different residue. */
function destroyRoom(slug, label) {
  const ch = `custom:${slug}`;
  const r = rooms.get(ch);
  if (r) {
    for (const c of [...r.members]) {
      c.channels.delete(ch);
      // Say WHY. A channel that silently vanishes reads as a disconnect, and the client would
      // cheerfully re-add it to customRooms and try to rejoin on the next reconnect.
      c.send({ t: "left", ch, reason: "deleted" });
      c.send({ t: "notice", level: "info", text: `“${label ?? slug}” was deleted.` });
    }
    r.members.clear();
    rooms.delete(ch);
  }
  customDir.delete(slug);
  store.deleteRoom(slug);
  broadcastDir();
  return true;
}

/** Join a custom room and hand back what the widget needs to describe it.
 *  🔑 The join CODE only ever goes to someone already inside the room — it is what admits the
 *  next person, so shipping it in the directory or on a refusal would defeat the whole gate. */
function joinCustom(conn, slug, meta) {
  const ch = `custom:${slug}`;
  joinRoom(conn, ch, meta.label, "custom");
  conn.send({
    t: "roominfo", ch,
    category: meta.category ?? DEFAULT_CATEGORY,
    privacy: meta.privacy ?? "public",
    owner: meta.owner ?? null,
    ...(meta.privacy === "private" ? { code: meta.code } : {}),
  });
  touchRoom(slug);
}

function leaveRoom(conn, ch) {
  if (!conn.channels.has(ch)) return;
  conn.channels.delete(ch);
  const r = rooms.get(ch);
  if (r) {
    r.members.delete(conn);
    // An empty region/shard room is garbage — shards churn every patch day. Global persists,
    // and CUSTOM rooms keep their object (and scrollback) while their directory entry lives;
    // pruneIdleRooms() is what finally retires them.
    if (r.members.size === 0 && (ch.startsWith("region:") || ch.startsWith("shard:"))) rooms.delete(ch);
    else presence(ch);
  }
  if (ch.startsWith("custom:")) {
    touchRoom(ch.slice("custom:".length));
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
// Exactly what dgsKey() emits: 10 lowercase hex characters. Nothing else is a DGS key.
const DGS_RE = /^[0-9a-f]{10}$/;
function locChannels(loc) {
  const out = [];
  const region = typeof loc.region === "string" ? loc.region.toLowerCase() : "";
  const shard = typeof loc.shard === "string" ? loc.shard : "";
  const dgs = typeof loc.dgs === "string" ? loc.dgs.toLowerCase() : "";
  if (REGION_RE.test(region)) out.push(`region:${region}`);
  if (SHARD_RE.test(shard) && shard !== "local_shard") out.push(`shard:${shard.toLowerCase()}`);
  // The DGS - the Dynamic Game Server running your area. Three tiers, finest last:
  //   region  use1b            everyone in US East
  //   shard   pub_use1b_..040  the persistent universe instance you are in
  //   dgs     <hash>           the server actually running where you ARE
  // 🔑 The client sends a HASH of ip:port, never the endpoint, so this server never learns and
  // never rebroadcasts a CIG address. Shape-checked so the key space stays exactly what the
  // client can produce and a crafted value cannot smuggle in a prefix.
  if (DGS_RE.test(dgs)) out.push(`dgs:${dgs}`);
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
    // 🔑 A health check says "I am alive", not "here is every room and who is in it". The room
    // map named every private and custom room and its occupancy to anyone on the internet —
    // which, for rooms whose whole point is not being listed, defeats the feature. The detail
    // moved to the loopback admin side, where the ban and room tools already live.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, mode: AUTH_MODE, connections: wss.clients.size, rooms: rooms.size }));
    return;
  }
  if (url === "/admin/health" && loopback(req)) {
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
      store.saveBan(handle);
    } else { bans.delete(handle); store.deleteBan(handle); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, bans: bans.size }));
    return;
  }
  // Moderation: list and delete ANY room, including ones with no owner (everything imported
  // from the old channels.json has owner NULL, so the owner-gated path can never touch them).
  // Loopback-only like the ban routes — an endpoint that ACTS with authority IS the authority.
  if (url === "/admin/rooms" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify([...customDir.entries()].map(([slug, m]) => ({
      slug, label: m.label, category: m.category, privacy: m.privacy, owner: m.owner,
      members: rooms.get(`custom:${slug}`)?.members.size ?? 0,
    }))));
    return;
  }
  if (url === "/admin/room-delete" && req.method === "POST") {
    const slug = String((await readBody(req)).slug ?? "").toLowerCase();
    const meta = customDir.get(slug);
    if (!meta) { res.writeHead(404, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: "no such room" })); return; }
    destroyRoom(slug, meta.label);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, deleted: slug, rooms: customDir.size }));
    return;
  }
  res.writeHead(404); res.end();
});

// ── WebSocket ───────────────────────────────────────────────────────────────
// 🔴 maxPayload. Without it `ws` will buffer a frame of ANY size — a single client streaming
// a huge message is an out-of-memory kill of the whole chat server for everyone. 16 KB is
// forty times the 400-character message limit, which leaves room for the biggest legitimate
// frame (a hello with a token) and nothing like enough for an attack.
const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 16 * 1024 });
const conns = new Set();

wss.on("connection", (ws) => {
  const conn = {
    ws,
    handle: null, handleLower: null, verified: false,
    channels: new Set(),
    stamps: [], // send timestamps for the message rate limit
    acts: [],   // and for access attempts (join / dm / invite / delete)
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
      // The category list rides the welcome frame so the widget's dropdown is rendered from the
      // server's list rather than a copy that drifts. v1 clients ignore the extra field.
      conn.send({ t: "welcome", you: { handle: conn.handle, verified: conn.verified }, categories: ROOM_CATEGORIES });
      joinRoom(conn, "global");
      // Verified org → its room, automatically. No setup, no invite — membership on the RSI
      // dossier IS the invite.
      if (id.org) joinRoom(conn, `org:${id.org.sid.toLowerCase()}`, id.org.name, "org");
      conn.send({ t: "dir", channels: dirPayload() });
      // Conversations waiting for them. Sent rather than asked for, because a DM received while
      // offline is the case DMs exist to handle — it has to be visible on the next login without
      // the user knowing to go looking.
      store.dmThreads(conn.handleLower)
        .then((threads) => { if (threads.length && conn.ws.readyState === 1) conn.send({ t: "dms", threads }); })
        .catch(() => { /* the list is a convenience; chat works without it */ });
      return;
    }
    if (!conn.handle) return; // nothing but hello before auth

    // 🔴 Rate-limit the frames that ATTEMPT ACCESS, not just the one that talks. `msg` was
    // limited from the start; `join` was not — and join doubles as "redeem this 6-character
    // code", so an attacker could guess codes as fast as the socket allowed. `dm` and `invite`
    // are here too: both reach a named stranger, so unlimited attempts are unlimited spam.
    // Separate budget from messages, because a burst of joins on connect is normal and must not
    // eat the allowance for actually speaking.
    if (f.t === "join" || f.t === "dm" || f.t === "invite" || f.t === "deleteRoom") {
      const now = Date.now();
      conn.acts = (conn.acts ?? []).filter((s) => now - s < ACT_WINDOW_MS);
      if (conn.acts.length >= ACT_N) {
        conn.send({ t: "error", code: "rate", message: "Too many attempts — wait a moment." });
        return;
      }
      conn.acts.push(now);
    }

    if (f.t === "loc") {
      const want = new Set(locChannels(f));
      // Only the AUTO location channels churn with the log — global/org/custom stay put.
      for (const ch of [...conn.channels])
        if ((ch.startsWith("region:") || ch.startsWith("shard:") || ch.startsWith("dgs:")) && !want.has(ch)) leaveRoom(conn, ch);
      for (const ch of want) joinRoom(conn, ch);
      return;
    }

    // Custom rooms: join-or-create by display name (mode narrows it: "join" = must exist,
    // "create" = must not).
    // v1 clients (0.1.41) send only {name, mode} — they get a public Social/Other room, exactly
    // what they got before categories existed. `category` and `privacy` are additive.
    if (f.t === "join") {
      const typed = String(f.name ?? "").trim().slice(0, 30);

      // A private room has no name anyone can look up, so the same box takes its CODE. Try that
      // first: a 6-char code and a 6-char room name are both plausible, and a code can only ever
      // match a room that deliberately handed it out.
      if (f.mode !== "create" && CODE_RE.test(typed)) {
        const hit = roomByCode(typed);
        if (hit) {
          if (!mayJoin(conn, hit.meta, typed)) { conn.send({ t: "error", code: "not_invited", message: "That code isn't valid any more." }); return; }
          // 🔑 Redeeming a code RECORDS an invite. Without this the code is the only way back
          // in, so the app reconnecting (or restarting) would silently drop them from a room
          // they are legitimately in — the client rejoins by NAME, and a name alone does not
          // open a private room. It also makes revocation mean something: pulling someone's
          // invite actually removes them, instead of them holding a permanent skeleton key.
          if (!hit.meta.invites.includes(conn.handleLower)) {
            hit.meta.invites.push(conn.handleLower);
            store.addInvite(hit.slug, conn.handleLower, "code");
          }
          joinCustom(conn, hit.slug, hit.meta);
          return;
        }
        // Not a code — fall through and try it as an ordinary name.
      }

      const slug = slugOfName(typed);
      if (!slug) { conn.send({ t: "error", code: "bad_channel", message: "Channel names are 3–30 letters, numbers, spaces or -._" }); return; }
      const existing = customDir.get(slug);

      if (f.mode === "join" && !existing) { conn.send({ t: "error", code: "no_such_channel", message: `No channel called “${typed}”.` }); return; }
      if (f.mode === "create" && existing) { conn.send({ t: "error", code: "channel_exists", message: `“${existing.label}” already exists — join it instead.` }); return; }

      if (existing) {
        // 🔑 A private room must be indistinguishable from one that does not exist. Saying
        // "that's private" confirms the name to anyone guessing, which is half of finding it.
        if (!mayJoin(conn, existing, typed)) {
          conn.send({ t: "error", code: "no_such_channel", message: `No channel called “${typed}”.` });
          return;
        }
        joinCustom(conn, slug, existing);
        return;
      }

      const category = CATEGORY_SLUGS.has(f.category) ? f.category : DEFAULT_CATEGORY;
      const privacy = f.privacy === "private" ? "private" : "public";
      const code = privacy === "private" ? makeCode() : null;
      if (privacy === "private" && !code) { conn.send({ t: "error", code: "bad_channel", message: "Couldn't allocate a join code — try again." }); return; }
      const meta = { slug, label: typed, category, privacy, code, owner: conn.handleLower,
                     created: Date.now(), lastActive: Date.now(), invites: [] };
      customDir.set(slug, meta);
      store.saveRoom(meta);
      broadcastDir();     // a no-op for a private room, which is never in the directory
      joinCustom(conn, slug, meta);
      return;
    }

    // Invite someone into a private room. Owner only — an invite is the power to widen access,
    // so it belongs to whoever accepted responsibility for the room by making it.
    if (f.t === "invite") {
      const ch = String(f.ch ?? "");
      const slug = ch.startsWith("custom:") ? ch.slice("custom:".length) : "";
      const meta = customDir.get(slug);
      if (!meta) { conn.send({ t: "error", code: "no_such_channel", message: "No such channel." }); return; }
      if (meta.owner !== conn.handleLower) { conn.send({ t: "error", code: "not_owner", message: "Only the person who made the room can invite to it." }); return; }
      const handle = String(f.handle ?? "").trim();
      if (!HANDLE_RE.test(handle)) { conn.send({ t: "error", code: "bad_handle", message: "That doesn't look like an RSI handle." }); return; }
      const lower = handle.toLowerCase();
      if (!meta.invites.includes(lower)) {
        meta.invites.push(lower);
        store.addInvite(slug, lower, conn.handleLower);
      }
      conn.send({ t: "invited", ch, handle });
      // Tell them now if they're online; otherwise the invite simply waits for them.
      for (const c of conns) {
        if (c.handleLower === lower && c.ws.readyState === 1) {
          c.send({ t: "roominvite", ch, label: meta.label, category: meta.category, from: conn.handle });
        }
      }
      return;
    }

    // Delete a room outright. Owner only — the same authority that can widen access can end it.
    // 🔑 This is a MODERATION tool as much as a tidy-up: a room's NAME is broadcast to every
    // user in the directory, so an inappropriate one is a problem the moment it exists and
    // "wait fourteen days for the idle prune" is not an answer.
    if (f.t === "deleteRoom") {
      const ch = String(f.ch ?? "");
      const slug = ch.startsWith("custom:") ? ch.slice("custom:".length) : "";
      const meta = customDir.get(slug);
      if (!meta) { conn.send({ t: "error", code: "no_such_channel", message: "No such channel." }); return; }
      if (meta.owner !== conn.handleLower) { conn.send({ t: "error", code: "not_owner", message: "Only the person who made the room can delete it." }); return; }
      destroyRoom(slug, meta.label);
      return;
    }

    if (f.t === "leave") {
      const ch = String(f.ch ?? "");
      // Only custom rooms and DMs are leavable — auto channels follow the log, the org room
      // follows the dossier. (Muting those is a CLIENT affordance, not membership.)
      if (!ch.startsWith("custom:") && !ch.startsWith("dm:")) { conn.send({ t: "error", code: "bad_channel", message: "Only custom channels can be left." }); return; }
      leaveRoom(conn, ch);
      return;
    }

    if (f.t === "msg") {
      const ch = String(f.ch ?? "");
      if (!conn.channels.has(ch)) { conn.send({ t: "error", code: "not_member", message: "Not in that channel." }); return; }
      const msg = deliver(conn, ch, f.text);
      if (msg && ch.startsWith("custom:")) touchRoom(ch.slice("custom:".length));
      return;
    }

    // ── Direct messages ──────────────────────────────────────────────────
    // A DM is an ordinary room whose key is the ORDERED pair of handles, so scrollback,
    // persistence, rate limiting and rendering are all the code that already existed. What is
    // different is only who may be in it and how you get there.
    if (f.t === "dm") {
      const to = String(f.to ?? "").trim();
      if (!HANDLE_RE.test(to)) { conn.send({ t: "error", code: "bad_handle", message: "That doesn't look like an RSI handle." }); return; }
      if (to.toLowerCase() === conn.handleLower) { conn.send({ t: "error", code: "bad_handle", message: "You can't message yourself." }); return; }
      if (bans.has(to.toLowerCase())) { conn.send({ t: "error", code: "no_such_handle", message: `Can't reach ${to}.` }); return; }
      const { ch, a, b } = dmKey(conn.handle, to);
      // Both ends join before the send, so the message lands live for whoever is online and in
      // scrollback for whoever isn't. 🔑 EVERY connection of theirs — a second window is the
      // same person and must not miss a DM.
      joinRoom(conn, ch, to, "dm");
      for (const c of conns) {
        if (c.handleLower === to.toLowerCase() && c.ws.readyState === 1) joinRoom(c, ch, conn.handle, "dm");
      }
      const msg = deliver(conn, ch, f.text);
      if (msg) store.touchDm(a, b, Date.now());
      return;
    }

    if (f.t === "dmlist") {
      store.dmThreads(conn.handleLower)
        .then((threads) => conn.send({ t: "dms", threads }))
        .catch((e) => { console.error("[chat] dm list failed:", e?.message); conn.send({ t: "dms", threads: [] }); });
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
        if (r.members.size === 0 && (ch.startsWith("region:") || ch.startsWith("shard:") || ch.startsWith("dgs:") || ch.startsWith("dm:"))) rooms.delete(ch);
        else presence(ch);
      }
      if (ch.startsWith("custom:")) {
        touchRoom(ch.slice("custom:".length));
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

// Retire idle rooms and trim scrollback to the same bound the in-memory ring keeps. Hourly:
// both are housekeeping, and doing them on a change would tie how often they run to how busy
// chat happens to be.
setInterval(() => {
  pruneIdleRooms();
  store.pruneMessages(HISTORY_KEEP)
    .then((n) => { if (n) console.log(`[chat-server] pruned ${n} old message(s)`); })
    .catch((e) => console.error("[chat-server] message prune failed:", e?.message));
}, PRUNE_EVERY_MS).unref();

// 🔴 Deploy footgun: CHAT_AUTH defaults to "dev", which accepts ANY hello.handle as verified.
// Mis-set (or unset) in production and every identity in chat is free to claim. Refuse to start
// that way unless someone says so out loud.
if (AUTH_MODE === "dev" && process.env.CHAT_ALLOW_DEV_AUTH !== "1") {
  console.error("[chat-server] REFUSING TO START: CHAT_AUTH is 'dev', which trusts any handle. "
    + "Set CHAT_AUTH=site for production, or CHAT_ALLOW_DEV_AUTH=1 if this really is a local test.");
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(`[chat-server] listening on :${PORT} (auth=${AUTH_MODE}, store=${store.mode}, `
    + `rooms=${customDir.size}, bans=${bans.size})`);
});

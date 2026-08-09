// Protocol test for the custom chat server: spawns the real server on a scratch port and
// drives two clients through auth → channels → messages → moderation. Offline by design
// (auth=dev); run with `node chat-server/server.test.mjs`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = 8797; // scratch — not 8788 (a dev chat server may be running) nor 8778 (sidecar)

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
const scratchData = mkdtempSync(join(tmpdir(), "sc-chat-test-"));

const server = spawn(process.execPath, [join(here, "server.mjs")], {
  env: { ...process.env, CHAT_PORT: String(PORT), CHAT_AUTH: "dev", CHAT_DATA_DIR: scratchData },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tiny test client: buffers every frame, lets the test await one by predicate. */
function client() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const frames = [];
  const waiters = [];
  ws.onmessage = (e) => {
    const f = JSON.parse(e.data);
    frames.push(f);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(f)) { waiters[i].resolve(f); waiters.splice(i, 1); }
    }
  };
  return {
    ws, frames,
    send: (f) => ws.send(JSON.stringify(f)),
    open: () => new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; }),
    next: (pred, why, ms = 3000) =>
      new Promise((resolve, reject) => {
        const hit = frames.find(pred);
        if (hit) return resolve(hit);
        const t = setTimeout(() => reject(new Error(`timeout waiting for: ${why}\nserver log:\n${serverLog}`)), ms);
        waiters.push({ pred, resolve: (f) => { clearTimeout(t); resolve(f); } });
      }),
  };
}

try {
  // Server up?
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await wait(250);
    try { up = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch { /* not yet */ }
  }
  assert(up, `chat server never answered /health\n${serverLog}`);

  // ── Auth + auto-join global ──
  const a = client();
  await a.open();
  a.send({ t: "hello", handle: "SubTest" });
  const wa = await a.next((f) => f.t === "welcome", "welcome A");
  assert.equal(wa.you.handle, "SubTest");
  await a.next((f) => f.t === "joined" && f.ch === "global", "A joins global");
  await a.next((f) => f.t === "history" && f.ch === "global", "A gets global history");

  // A bad handle is refused before it can say anything.
  const bad = client();
  await bad.open();
  bad.send({ t: "hello", handle: "x" });
  await bad.next((f) => f.t === "error" && f.code === "bad_auth", "junk handle refused");

  // ── Location → region + shard channels (Sub's 3-tier hierarchy) ──
  a.send({ t: "loc", region: "use1b", shard: "pub_use1b_12326004_040" });
  await a.next((f) => f.t === "joined" && f.ch === "region:use1b", "A joins region");
  await a.next((f) => f.t === "joined" && f.ch === "shard:pub_use1b_12326004_040", "A joins shard");

  // Second client, same shard — must see A's shard message; a third on another shard must not.
  const b = client();
  await b.open();
  b.send({ t: "hello", handle: "WingmanTest" });
  await b.next((f) => f.t === "welcome", "welcome B");
  b.send({ t: "loc", region: "use1b", shard: "pub_use1b_12326004_040" });
  await b.next((f) => f.t === "joined" && f.ch === "shard:pub_use1b_12326004_040", "B joins shard");

  const c = client();
  await c.open();
  c.send({ t: "hello", handle: "StrangerTest" });
  await c.next((f) => f.t === "welcome", "welcome C");
  c.send({ t: "loc", region: "usw2a", shard: "pub_usw2a_12326004_007" });
  await c.next((f) => f.t === "joined" && f.ch === "region:usw2a", "C joins its own region");

  a.send({ t: "msg", ch: "shard:pub_use1b_12326004_040", text: "meet at Seraphim?" });
  const got = await b.next((f) => f.t === "msg" && f.ch === "shard:pub_use1b_12326004_040", "B hears A");
  assert.equal(got.text, "meet at Seraphim?");
  assert.equal(got.from.handle, "SubTest");
  assert.equal(got.from.verified, true);

  // Global reaches everyone, including the other-shard client.
  a.send({ t: "msg", ch: "global", text: "hello universe" });
  await c.next((f) => f.t === "msg" && f.ch === "global" && f.text === "hello universe", "C hears global");
  // ...but C never saw the shard message (it was never a member).
  assert(!c.frames.some((f) => f.t === "msg" && f.ch?.startsWith("shard:pub_use1b")), "shard chat must not leak across shards");

  // Sending into a channel you're not in is refused.
  c.send({ t: "msg", ch: "shard:pub_use1b_12326004_040", text: "sneaky" });
  await c.next((f) => f.t === "error" && f.code === "not_member", "cross-shard send refused");

  // ── Shard hop: new loc replaces the old region/shard rooms, keeps global ──
  b.send({ t: "loc", region: "usw2a", shard: "pub_usw2a_12326004_007" });
  await b.next((f) => f.t === "left" && f.ch === "shard:pub_use1b_12326004_040", "B leaves old shard");
  await b.next((f) => f.t === "joined" && f.ch === "shard:pub_usw2a_12326004_007", "B joins new shard");

  // Leaving the PU (menu/quit): loc with nulls drops region+shard, keeps global.
  b.send({ t: "loc", region: null, shard: null });
  await b.next((f) => f.t === "left" && f.ch === "region:usw2a", "B leaves region on menu");

  // ── History: a late joiner sees the scrollback ──
  const late = client();
  await late.open();
  late.send({ t: "hello", handle: "LateTest" });
  await late.next((f) => f.t === "welcome", "welcome late");
  const hist = await late.next((f) => f.t === "history" && f.ch === "global", "late history");
  assert(hist.msgs.some((m) => m.text === "hello universe"), "history must carry earlier messages");

  // ── Rate limit: 6th message inside the window is refused ──
  for (let i = 0; i < 6; i++) a.send({ t: "msg", ch: "global", text: `spam ${i}` });
  await a.next((f) => f.t === "error" && f.code === "rate", "rate limit trips");

  // ── Ban (loopback admin): banned handle is kicked and cannot reconnect ──
  const res = await fetch(`http://127.0.0.1:${PORT}/admin/ban`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "strangertest" }),
  });
  assert((await res.json()).ok, "ban should apply");
  await c.next((f) => f.t === "error" && f.code === "banned", "banned client is told");
  const c2 = client();
  await c2.open();
  c2.send({ t: "hello", handle: "StrangerTest" });
  await c2.next((f) => f.t === "error" && f.code === "banned", "banned handle cannot rejoin");
  await fetch(`http://127.0.0.1:${PORT}/admin/unban`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "strangertest" }),
  });

  // ── v2: member lists ride presence ──
  const withMembers = await a.next((f) => f.t === "presence" && f.ch === "global" && Array.isArray(f.members), "presence carries members");
  assert(withMembers.members.every((m) => typeof m.handle === "string" && typeof m.verified === "boolean"), "member rows have handle+verified");
  assert(withMembers.count >= 1, "count is at least the sender");

  // ── v2: org auto-join (dev passthrough) ──
  const o = client();
  await o.open();
  o.send({ t: "hello", handle: "OrgPilot", org: { sid: "IRREGS", name: "7th Nul Irregulars" } });
  const oj = await o.next((f) => f.t === "joined" && f.ch === "org:irregs", "org room auto-joined");
  assert.equal(oj.label, "7th Nul Irregulars", "org room carries the org NAME as label");
  assert.equal(oj.kind, "org");
  await o.next((f) => f.t === "dir" && Array.isArray(f.channels), "directory arrives on welcome");

  // ── v2: custom rooms — create, directory, join by name, leave ──
  o.send({ t: "join", name: "Salvage Crew" });
  const cj = await o.next((f) => f.t === "joined" && f.ch === "custom:salvage-crew", "custom room created+joined");
  assert.equal(cj.label, "Salvage Crew", "custom room keeps display casing");
  // mode:"create" on a taken name refuses; mode:"join" on a missing one refuses.
  o.send({ t: "join", name: "salvage crew", mode: "create" });
  await o.next((f) => f.t === "error" && f.code === "channel_exists", "create refuses a taken name");
  o.send({ t: "join", name: "no such room", mode: "join" });
  await o.next((f) => f.t === "error" && f.code === "no_such_channel", "join refuses a missing name");
  // Another client sees it in the directory and joins by the same display name.
  const dirSeen = await a.next((f) => f.t === "dir" && f.channels.some((c) => c.ch === "custom:salvage-crew"), "directory broadcast reaches others");
  assert.equal(dirSeen.channels.find((c) => c.ch === "custom:salvage-crew").label, "Salvage Crew");
  a.send({ t: "join", name: "SALVAGE CREW", mode: "join" });
  await a.next((f) => f.t === "joined" && f.ch === "custom:salvage-crew", "join is case-insensitive on the name");
  const waitMsg = a.next((f) => f.t === "msg" && f.ch === "custom:salvage-crew", "custom room delivers");
  o.send({ t: "msg", ch: "custom:salvage-crew", text: "anyone got a Reclaimer?" });
  await waitMsg;
  // Leaving: custom yes, auto/org no.
  a.send({ t: "leave", ch: "custom:salvage-crew" });
  await a.next((f) => f.t === "left" && f.ch === "custom:salvage-crew", "custom room left");
  o.send({ t: "leave", ch: "org:irregs" });
  await o.next((f) => f.t === "error" && f.code === "bad_channel", "org room refuses leave");
  // Location churn must NOT drop org/custom membership.
  o.send({ t: "loc", region: "use1b", shard: "pub_use1b_12326004_040" });
  await o.next((f) => f.t === "joined" && f.ch === "shard:pub_use1b_12326004_040", "org client lands on shard");
  o.send({ t: "loc", region: null, shard: null });
  await o.next((f) => f.t === "left" && f.ch === "region:use1b", "loc churn drops region");
  o.send({ t: "msg", ch: "org:irregs", text: "still here" });
  await o.next((f) => f.t === "msg" && f.ch === "org:irregs" && f.text === "still here", "org membership survived loc churn");

  // ── emoji survive the round trip, and truncation never splits one ──
  // 🔑 A FRESH client: `a` burned its rate-limit window on the spam test above, and a
  // rate-refused send looks exactly like a delivery failure from the outside.
  const em1 = client();
  await em1.open();
  em1.send({ t: "hello", handle: "EmojiTest" });
  await em1.next((f) => f.t === "welcome", "welcome emoji client");
  const emojiWait = em1.next((f) => f.t === "msg" && f.ch === "global" && f.text.includes("🫡"), "emoji delivered intact");
  em1.send({ t: "msg", ch: "global", text: "o7 🫡 mining ⛏️ done 💯" });
  const em = await emojiWait;
  assert.equal(em.text, "o7 🫡 mining ⛏️ done 💯", "multi-byte emoji survive byte-for-byte");
  // 🔑 400 emoji is 800 UTF-16 units — a .slice(0,400) would cut the 400th in half and emit a
  // lone surrogate. Truncation is by code point, so the tail must still be a whole emoji.
  const longWait = em1.next((f) => f.t === "msg" && f.ch === "global" && f.text.startsWith("🚀"), "long emoji message");
  em1.send({ t: "msg", ch: "global", text: "🚀".repeat(500) });
  const long = await longWait;
  assert.equal([...long.text].length, 400, "truncated to 400 CODE POINTS");
  assert(!/[\uD800-\uDFFF]/.test(long.text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, "")),
    "no lone surrogate survives truncation");

  console.log("chat-server tests passed");
} finally {
  server.kill();
}

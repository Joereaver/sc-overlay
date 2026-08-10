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
  env: { ...process.env, CHAT_PORT: String(PORT), CHAT_AUTH: "dev", CHAT_DATA_DIR: scratchData,
         // Dev auth trusts any handle, so the server refuses to boot with it unless told.
         CHAT_ALLOW_DEV_AUTH: "1" },
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

  // ── Location → TWO tiers: region (US East 1B) and the DGS. No shard room. ──
  // 🔑 The AZ LETTER is part of the region key, so use1b and use1a are different rooms — this
  // is already "everyone specifically on US East 1B", which is why the shard tier was dropped.
  a.send({ t: "loc", region: "use1b", shard: "pub_use1b_12326004_040", dgs: "aaaa111122" });
  await a.next((f) => f.t === "joined" && f.ch === "region:use1b", "A joins its region");
  await wait(250);
  assert(!a.frames.some((f) => f.t === "joined" && String(f.ch).startsWith("shard:")),
    "no shard room is created at all — the tier is gone, not merely hidden");

  // Second client, same region — must see A's message; a third in another region must not.
  const b = client();
  await b.open();
  b.send({ t: "hello", handle: "WingmanTest" });
  await b.next((f) => f.t === "welcome", "welcome B");
  b.send({ t: "loc", region: "use1b", shard: "pub_use1b_12326004_040", dgs: "aaaa111122" });
  await b.next((f) => f.t === "joined" && f.ch === "region:use1b", "B joins the same region");

  const c = client();
  await c.open();
  c.send({ t: "hello", handle: "StrangerTest" });
  await c.next((f) => f.t === "welcome", "welcome C");
  c.send({ t: "loc", region: "usw2a", shard: "pub_usw2a_12326004_007", dgs: "cccc333344" });
  await c.next((f) => f.t === "joined" && f.ch === "region:usw2a", "C joins its own region");

  a.send({ t: "msg", ch: "region:use1b", text: "meet at Seraphim?" });
  const got = await b.next((f) => f.t === "msg" && f.ch === "region:use1b", "B hears A");
  assert.equal(got.text, "meet at Seraphim?");
  assert.equal(got.from.handle, "SubTest");
  assert.equal(got.from.verified, true);

  // Global reaches everyone, including the client in another region.
  a.send({ t: "msg", ch: "global", text: "hello universe" });
  await c.next((f) => f.t === "msg" && f.ch === "global" && f.text === "hello universe", "C hears global");
  // ...but C never saw the shard message (it was never a member).
  assert(!c.frames.some((f) => f.t === "msg" && f.ch === "region:use1b"), "region chat must not leak across regions");

  // Sending into a channel you're not in is refused.
  c.send({ t: "msg", ch: "region:use1b", text: "sneaky" });
  await c.next((f) => f.t === "error" && f.code === "not_member", "cross-region send refused");

  // ── Region hop: a new loc replaces the old location rooms, keeps global ──
  b.send({ t: "loc", region: "usw2a", shard: "pub_usw2a_12326004_007", dgs: "bbbb222233" });
  await b.next((f) => f.t === "left" && f.ch === "region:use1b", "B leaves the old region");
  await b.next((f) => f.t === "joined" && f.ch === "region:usw2a", "B joins the new one");

  // Leaving the PU (menu/quit): loc with nulls drops the location rooms, keeps global.
  b.send({ t: "loc", region: null, shard: null, dgs: null });
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
  o.send({ t: "loc", region: "use1b", shard: "pub_use1b_12326004_040", dgs: "eeee555566" });
  await o.next((f) => f.t === "joined" && f.ch === "region:use1b", "org client lands in its region");
  o.send({ t: "loc", region: null, shard: null, dgs: null });
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

  // ── room categories, privacy, join codes and invites ──────────────────────
  // Sub, 2026-08-09: rooms are categorised by the gameplay people are doing, and creating one
  // must no longer publish it to everybody by force.
  const owner = client();
  await owner.open();
  owner.send({ t: "hello", handle: "RoomOwner" });
  const ownerWelcome = await owner.next((f) => f.t === "welcome", "welcome room owner");
  assert(Array.isArray(ownerWelcome.categories) && ownerWelcome.categories.length === 12,
    "the welcome frame carries the activity list the dropdown is built from");
  assert(ownerWelcome.categories.some((c) => c.slug === "org-ops" && c.label === "Org Operations"),
    "categories are {slug,label}");

  // A PUBLIC room is listed, and carries its category.
  owner.send({ t: "join", name: "Halo Mining", mode: "create", category: "mining", privacy: "public" });
  await owner.next((f) => f.t === "joined" && f.ch === "custom:halo-mining", "created a public room");
  const pubInfo = await owner.next((f) => f.t === "roominfo" && f.ch === "custom:halo-mining", "roominfo for the public room");
  assert.equal(pubInfo.category, "mining", "the category was stored");
  assert.equal(pubInfo.privacy, "public");
  assert.equal(pubInfo.code, undefined, "a public room has no join code to leak");
  const pubDir = await owner.next(
    (f) => f.t === "dir" && f.channels.some((c) => c.ch === "custom:halo-mining"), "public room is in the directory");
  assert.equal(pubDir.channels.find((c) => c.ch === "custom:halo-mining").category, "mining",
    "the directory carries the category so it can group by activity");

  // A PRIVATE room is not.
  owner.send({ t: "join", name: "Sunday Ops", mode: "create", category: "org-ops", privacy: "private" });
  await owner.next((f) => f.t === "joined" && f.ch === "custom:sunday-ops", "created a private room");
  const privInfo = await owner.next((f) => f.t === "roominfo" && f.ch === "custom:sunday-ops", "roominfo for the private room");
  assert.equal(privInfo.privacy, "private");
  assert.match(privInfo.code, /^[A-HJ-NP-Z2-9]{6}$/, "a private room gets a shareable code with no O/0/I/1");
  const code = privInfo.code;
  await wait(700);   // the directory broadcast is debounced
  const lastDir = [...owner.frames].reverse().find((f) => f.t === "dir");
  assert(!lastDir.channels.some((c) => c.ch === "custom:sunday-ops"),
    "🔑 a private room is ABSENT from the directory, not merely flagged in it");

  // An outsider can't get in, and isn't told the room exists.
  const outsider = client();
  await outsider.open();
  outsider.send({ t: "hello", handle: "Outsider" });
  await outsider.next((f) => f.t === "welcome", "welcome outsider");
  outsider.send({ t: "join", name: "Sunday Ops", mode: "join" });
  const refused = await outsider.next((f) => f.t === "error", "outsider refused");
  assert.equal(refused.code, "no_such_channel",
    "🔑 a private room reads as NON-EXISTENT — 'that's private' would confirm the name to anyone guessing");

  // ...but the code lets them in.
  outsider.send({ t: "join", name: code });
  await outsider.next((f) => f.t === "joined" && f.ch === "custom:sunday-ops", "the join code admits an outsider");
  const lower = await outsider.next((f) => f.t === "roominfo" && f.ch === "custom:sunday-ops", "roominfo after code join");
  assert.equal(lower.code, code, "someone inside the room can see the code, to pass it on");
  outsider.send({ t: "leave", ch: "custom:sunday-ops" });
  await outsider.next((f) => f.t === "left" && f.ch === "custom:sunday-ops", "outsider left");

  // 🔑 Redeeming the code recorded an invite, so they can now get back in BY NAME. Without
  // this the client's rejoin-by-name on reconnect would silently drop them from the room.
  outsider.send({ t: "join", name: "Sunday Ops", mode: "join" });
  await outsider.next((f) => f.t === "joined" && f.ch === "custom:sunday-ops",
    "having used the code once, they rejoin by name — a reconnect must not lock them out");
  outsider.send({ t: "leave", ch: "custom:sunday-ops" });
  await outsider.next((f) => f.t === "left" && f.ch === "custom:sunday-ops", "outsider left again");

  // A lowercase code still works — it gets read off Discord and typed by hand.
  outsider.send({ t: "join", name: code.toLowerCase() });
  await outsider.next((f) => f.t === "joined" && f.ch === "custom:sunday-ops", "codes are case-insensitive");

  // Invite by handle: the second door, and owner-only.
  const guest = client();
  await guest.open();
  guest.send({ t: "hello", handle: "Guest" });
  await guest.next((f) => f.t === "welcome", "welcome guest");
  outsider.send({ t: "invite", ch: "custom:sunday-ops", handle: "Guest" });
  const notOwner = await outsider.next((f) => f.t === "error" && f.code === "not_owner", "a member cannot invite");
  assert(notOwner, "only the owner may widen access");

  owner.send({ t: "invite", ch: "custom:sunday-ops", handle: "Guest" });
  await owner.next((f) => f.t === "invited" && f.handle === "Guest", "invite recorded");
  const ping = await guest.next((f) => f.t === "roominvite" && f.ch === "custom:sunday-ops", "the invitee is told");
  assert.equal(ping.from, "RoomOwner");
  assert.equal(ping.label, "Sunday Ops");
  guest.send({ t: "join", name: "Sunday Ops", mode: "join" });
  await guest.next((f) => f.t === "joined" && f.ch === "custom:sunday-ops", "an invited handle joins by NAME, no code");

  // A v1 client (0.1.41) sends neither field and must still get exactly what it always got.
  owner.send({ t: "join", name: "Old Client Room", mode: "create" });
  const v1 = await owner.next((f) => f.t === "roominfo" && f.ch === "custom:old-client-room", "v1-shaped create still works");
  assert.equal(v1.privacy, "public", "backward compatible: no privacy field means public");
  assert.equal(v1.category, "social", "backward compatible: no category means Social / Other");
  // A junk category is corrected, not refused — the room is what the user wanted either way.
  owner.send({ t: "join", name: "Junk Cat", mode: "create", category: "not-a-real-category" });
  const junk = await owner.next((f) => f.t === "roominfo" && f.ch === "custom:junk-cat", "junk category");
  assert.equal(junk.category, "social", "an unknown category falls back rather than failing the create");

  // ── ORG ISOLATION ─────────────────────────────────────────────────────────
  // 🔴 Sub's stated top priority: "I don't want someone to be able to spy on a rival org."
  // Org membership comes ONLY from the verified RSI dossier at hello — there is no frame that
  // joins an org room, and these assertions are what keep it that way.
  const rival = client();
  await rival.open();
  rival.send({ t: "hello", handle: "RivalSpy", org: { sid: "RIVALS", name: "Rival Corp" } });
  await rival.next((f) => f.t === "welcome", "welcome rival");
  await rival.next((f) => f.t === "joined" && f.ch === "org:rivals", "rival lands in its OWN org");

  // Reading someone else's org is refused by membership, like any other room.
  rival.send({ t: "msg", ch: "org:irregs", text: "listening in" });
  await rival.next((f) => f.t === "error" && f.code === "not_member", "cannot post into another org");

  // There is no join verb for orgs — the custom-room one slugifies the colon away, so it can
  // only ever create `custom:orgirregs`, never `org:irregs`.
  rival.send({ t: "join", name: "org:IRREGS" });
  await wait(300);
  assert(!rival.frames.some((f) => f.t === "joined" && f.ch === "org:irregs"),
    "the custom-room join cannot reach an org room");

  // 🔑 And `loc` cannot either. It is the one frame whose channel names come from the client,
  // so it is the natural place to try to smuggle a prefix. region/shard/dgs are all shape-checked
  // and none of the patterns permits a colon.
  rival.send({ t: "loc", region: "org:irregs", shard: "org:irregs", dgs: "org:irregs" });
  await wait(300);
  assert(!rival.frames.some((f) => f.t === "joined" && String(f.ch).startsWith("org:") && f.ch !== "org:rivals"),
    "a crafted loc cannot smuggle its way into an org room");

  // The org room really is carrying traffic for its own members only.
  const orgMate = client();
  await orgMate.open();
  orgMate.send({ t: "hello", handle: "OrgMate", org: { sid: "IRREGS", name: "7th Nul Irregulars" } });
  await orgMate.next((f) => f.t === "joined" && f.ch === "org:irregs", "org mate joins");
  o.send({ t: "msg", ch: "org:irregs", text: "org secret" });
  await orgMate.next((f) => f.t === "msg" && f.text === "org secret", "org mates hear each other");
  await wait(200);
  assert(!rival.frames.some((f) => f.t === "msg" && f.text === "org secret"),
    "🔴 the rival NEVER sees org traffic");

  // ── impersonation guard ───────────────────────────────────────────────────
  // 🔴 Demonstrated on Sub's own server: a tester made rooms called irregs, sabreraven, ltx,
  // sbb and imc-subliminallianori. Nothing technical broke — the harm is that a member joins
  // the fake "irregs" thinking it is the org channel and talks freely in it.
  rival.send({ t: "join", name: "IRREGS", mode: "create" });
  const taken = await rival.next((f) => f.t === "error" && f.code === "name_reserved", "org name is reserved");
  assert.match(taken.message, /org or a player/, "and it says why");

  rival.send({ t: "join", name: "OrgPilot", mode: "create" });
  await rival.next((f) => f.t === "error" && f.code === "name_reserved", "a player's handle is reserved too");

  // Its OWN org counts as well — you cannot squat your own org's name either, because the room
  // would still be mistaken for the real channel by everyone else in it.
  rival.send({ t: "join", name: "RIVALS", mode: "create" });
  await rival.next((f) => f.t === "error" && f.code === "name_reserved", "your own org is reserved");

  // Ordinary names are unaffected — the guard must not turn into "no rooms allowed".
  rival.send({ t: "join", name: "Sunday Salvage", mode: "create" });
  await rival.next((f) => f.t === "joined" && f.ch === "custom:sunday-salvage", "a normal name still works");
  rival.send({ t: "deleteRoom", ch: "custom:sunday-salvage" });
  await rival.next((f) => f.t === "left" && f.ch === "custom:sunday-salvage", "cleaned up");

  // ── the DGS tier, and the rate limit on access attempts ───────────────────
  // region -> shard -> dgs. The DGS key is a HASH of the server's ip:port produced by the
  // client, so this server never sees or rebroadcasts a CIG address.
  const loc = client();
  await loc.open();
  loc.send({ t: "hello", handle: "Traveller" });
  await loc.next((f) => f.t === "welcome", "welcome traveller");
  loc.send({ t: "loc", region: "use1b", shard: "pub_use1b_12326004_040", dgs: "a3f9c21e04" });
  await loc.next((f) => f.t === "joined" && f.ch === "dgs:a3f9c21e04", "joined the DGS room");
  await loc.next((f) => f.t === "joined" && f.ch === "region:use1b", "and the region");

  // Meshing hands you to another DGS WITHIN the same shard - the finest room must follow.
  loc.send({ t: "loc", region: "use1b", shard: "pub_use1b_12326004_040", dgs: "bb11cc22dd" });
  await loc.next((f) => f.t === "left" && f.ch === "dgs:a3f9c21e04", "left the old DGS");
  await loc.next((f) => f.t === "joined" && f.ch === "dgs:bb11cc22dd", "joined the new one");
  assert(loc.frames.every((f) => !(f.t === "left" && f.ch === "region:use1b")),
    "...without churning the region room, which did not change");

  // Anything that is not exactly what dgsKey() emits is not a DGS key. This is what stops a
  // crafted value smuggling in a different key space.
  // (Uppercase hex is NOT in this list: it lower-cases to a valid key, which is correct
  // normalisation rather than a bypass — the key space is unchanged.)
  for (const bad of ["1.2.3.4:64304", "a3f9c21e0", "a3f9c21e04x", "../global", "deadbeefzz"]) {
    const mark = loc.frames.length;   // only judge frames from THIS attempt onwards
    loc.send({ t: "loc", region: "use1b", shard: "pub_use1b_12326004_040", dgs: bad });
    await wait(80);
    const joined = loc.frames.slice(mark).filter((f) => f.t === "joined" && String(f.ch).startsWith("dgs:"));
    assert.equal(joined.length, 0, "a malformed DGS key is refused: " + bad);
  }

  // Access attempts are rate limited. `msg` always was; `join` was not - and join doubles as
  // "redeem this 6-character code", so unlimited attempts meant unlimited code guessing.
  const bf = client();
  await bf.open();
  bf.send({ t: "hello", handle: "Bruteforcer" });
  await bf.next((f) => f.t === "welcome", "welcome bruteforcer");
  for (let i = 0; i < 20; i++) bf.send({ t: "join", name: "ABC" + String(i).padStart(3, "2") });
  const limited = await bf.next((f) => f.t === "error" && f.code === "rate", "join attempts are rate limited");
  assert(limited, "a code guesser is throttled");

  // ── deleting a room ───────────────────────────────────────────────────────
  // Sub's reason is moderation: a room's NAME is broadcast to every user in the directory, so
  // an inappropriate one is a problem the moment it exists — "wait for the 14-day idle prune"
  // is not an answer.
  owner.send({ t: "join", name: "Doomed Room", mode: "create", category: "mining", privacy: "public" });
  await owner.next((f) => f.t === "joined" && f.ch === "custom:doomed-room", "created the doomed room");
  guest.send({ t: "join", name: "Doomed Room", mode: "join" });
  await guest.next((f) => f.t === "joined" && f.ch === "custom:doomed-room", "guest joined it");

  guest.send({ t: "deleteRoom", ch: "custom:doomed-room" });
  await guest.next((f) => f.t === "error" && f.code === "not_owner", "a member cannot delete a room");

  owner.send({ t: "deleteRoom", ch: "custom:doomed-room" });
  const evicted = await guest.next((f) => f.t === "left" && f.ch === "custom:doomed-room", "the guest is evicted");
  assert.equal(evicted.reason, "deleted",
    "the eviction says WHY — a channel that just vanishes reads as a disconnect and the client would try to rejoin it");
  await guest.next((f) => f.t === "notice" && /Doomed Room/.test(f.text ?? ""), "and the guest is told");
  await wait(700);
  const dirAfter = [...owner.frames].reverse().find((f) => f.t === "dir");
  assert(!dirAfter.channels.some((c) => c.ch === "custom:doomed-room"), "gone from the directory");

  // Really gone: re-creating it must be a CREATE, not a join onto leftover state.
  owner.send({ t: "join", name: "Doomed Room", mode: "create", category: "salvage", privacy: "public" });
  await wait(400);
  // 🔑 The LAST matching frame, not next(): the helper searches already-buffered frames from the
  // start, so it would hand back the roominfo from the room's first life and the assertion would
  // "fail" on a server that behaved perfectly.
  const reborn = [...owner.frames].reverse().find((f) => f.t === "roominfo" && f.ch === "custom:doomed-room");
  assert.equal(reborn.category, "salvage", "the new room is genuinely new, not the old one revived");
  owner.send({ t: "deleteRoom", ch: "custom:doomed-room" });
  await owner.next((f) => f.t === "left" && f.ch === "custom:doomed-room", "cleaned up");

  // The loopback admin route — the ONLY way to remove a room with no owner, which is every
  // room imported from the old channels.json.
  const roomsBefore = await (await fetch(`http://127.0.0.1:${PORT}/admin/rooms`)).json();
  assert(Array.isArray(roomsBefore) && roomsBefore.some((r) => r.slug === "halo-mining"),
    "admin can list rooms");
  const del = await (await fetch(`http://127.0.0.1:${PORT}/admin/room-delete`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug: "halo-mining" }),
  })).json();
  assert.equal(del.ok, true, "admin delete succeeds");
  const roomsAfter = await (await fetch(`http://127.0.0.1:${PORT}/admin/rooms`)).json();
  assert(!roomsAfter.some((r) => r.slug === "halo-mining"), "admin delete removes an ownerless room");

  // ── direct messages ───────────────────────────────────────────────────────
  const dmA = client();
  await dmA.open();
  dmA.send({ t: "hello", handle: "Alice" });
  await dmA.next((f) => f.t === "welcome", "welcome Alice");
  const dmB = client();
  await dmB.open();
  dmB.send({ t: "hello", handle: "Bob" });
  await dmB.next((f) => f.t === "welcome", "welcome Bob");

  dmA.send({ t: "dm", to: "Bob", text: "code is " + code });
  const gotA = await dmA.next((f) => f.t === "msg" && f.ch.startsWith("dm:"), "sender sees their own DM");
  const gotB = await dmB.next((f) => f.t === "msg" && f.ch.startsWith("dm:"), "recipient receives the DM");
  assert.equal(gotB.text, "code is " + code, "which is the whole point of DMs — handing over a join code");
  assert.equal(gotA.ch, gotB.ch, "both ends are in the SAME room");
  assert.equal(gotA.ch, "dm:alice|bob", "the room key is the ordered, lowercased pair");

  // Replying the other way must not open a second half-conversation.
  dmB.send({ t: "dm", to: "Alice", text: "on my way" });
  const back = await dmA.next((f) => f.t === "msg" && f.text === "on my way", "reply arrives");
  assert.equal(back.ch, "dm:alice|bob", "🔑 (a,b) and (b,a) are ONE conversation, not two");

  dmA.send({ t: "dm", to: "Alice", text: "hello me" });
  await dmA.next((f) => f.t === "error" && f.code === "bad_handle", "you can't DM yourself");
  dmA.send({ t: "dm", to: "not a handle!", text: "hi" });
  await dmA.next((f) => f.t === "error" && f.code === "bad_handle", "a malformed handle is refused");

  // A third party must not be able to reach into someone else's conversation.
  const nosy = client();
  await nosy.open();
  nosy.send({ t: "hello", handle: "Nosy" });
  await nosy.next((f) => f.t === "welcome", "welcome Nosy");
  nosy.send({ t: "msg", ch: "dm:alice|bob", text: "let me in" });
  const kept = await nosy.next((f) => f.t === "error" && f.code === "not_member", "outsiders can't post into a DM");
  assert(kept, "DM membership is enforced by the same not_member rule as every other room");

  console.log("chat-server tests passed");
} finally {
  server.kill();
}

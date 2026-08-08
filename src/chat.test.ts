// ChatClient (the sidecar's half) against BOTH real A/B backends:
//   1. the custom chat server (chat-server/server.mjs) — 3-tier channels, spawned here
//   2. a local Centrifugo (spawned from PATH; SKIPPED with a notice when not installed)
// Run: npx tsx src/chat.test.ts
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { ChatClient, regionLabel, shardLabel } from "./chat.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const CUSTOM_PORT = 8796;   // scratch — not 8788 (a dev chat server) nor 8778 (the sidecar)
const CENTRIFUGO_PORT = 8798;
const SHARD = "pub_use1b_12326004_040";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until a ChatClient SSE event satisfies the predicate. State predicates are ALSO tried
 *  against the current view first — the frame may have fired before the listener attached. */
function until(client: ChatClient, pred: (f: any) => boolean, why: string, ms = 6000): Promise<any> {
  const now = { type: "state", view: client.view() };
  if (pred(now)) return Promise.resolve(now);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { client.off("sse", on); reject(new Error("timeout: " + why)); }, ms);
    const on = (f: any) => { if (pred(f)) { clearTimeout(t); client.off("sse", on); resolve(f); } };
    client.on("sse", on);
  });
}
const connected = (c: ChatClient) => until(c, (f) => f.type === "state" && f.view.status === "connected", "connected");

// ── labels ──────────────────────────────────────────────────────────────────
assert.equal(regionLabel("use1b"), "US East 1B");
assert.equal(regionLabel("usw2a"), "US West 2A");
assert.equal(regionLabel("euw1b"), "EU West 1B");
assert.equal(shardLabel(SHARD), "Shard 040");

// ── custom backend ──────────────────────────────────────────────────────────
async function testCustom(): Promise<void> {
  const server = spawn(process.execPath, [join(repo, "chat-server", "server.mjs")], {
    env: { ...process.env, CHAT_PORT: String(CUSTOM_PORT), CHAT_AUTH: "dev" },
    stdio: "ignore",
    windowsHide: true,
  });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await wait(250);
      try { up = (await fetch(`http://127.0.0.1:${CUSTOM_PORT}/health`)).ok; } catch { /* not yet */ }
    }
    assert(up, "custom chat server never came up");

    const opts = (handle: string) => ({
      backend: "custom" as const, url: `ws://127.0.0.1:${CUSTOM_PORT}/ws`, handle, token: "",
    });
    const a = new ChatClient();
    const b = new ChatClient();
    const wa = connected(a);
    a.configure(opts("SubTest"), true);
    await wa;

    // Shard applied BEFORE b connects — the loc must ride the connect, not only a later change.
    b.applyShard(SHARD);
    const wb = connected(b);
    b.configure(opts("WingmanTest"), true);
    await wb;
    a.applyShard(SHARD);

    await until(a, (f) => f.type === "state" && f.view.channels.some((c: any) => c.kind === "shard"), "A in shard channel");
    await until(b, (f) => f.type === "state" && f.view.channels.some((c: any) => c.kind === "shard"), "B in shard channel");
    const va = a.view();
    assert.deepEqual(va.channels.map((c) => c.kind), ["global", "region", "shard"], "hierarchy order");
    assert.equal(va.channels[1].label, "US East 1B");
    assert.equal(va.channels[2].label, "Shard 040");

    const heard = until(b, (f) => f.type === "msg" && f.msg.text === "meet at Seraphim?", "B hears A's shard message");
    assert.equal(a.send(`shard:${SHARD.toLowerCase()}`, "meet at Seraphim?").ok, true);
    const got = await heard;
    assert.equal(got.msg.from.handle, "SubTest");

    // Leaving the PU drops region+shard, keeps global (and its history).
    a.applyShard(null);
    await until(a, (f) => f.type === "state" && f.view.channels.length === 1 && f.view.channels[0].kind === "global", "A back to global only");

    a.configure(opts("SubTest"), false); // widget closed → deliberate disconnect, no retry
    b.configure(opts("WingmanTest"), false);
    assert.equal(a.view().status, "off");
    console.log("chat client vs custom backend: ok");
  } finally {
    server.kill();
  }
}

// ── centrifugo backend (one global room — the deliberately-shallow A/B arm) ──
async function testCentrifugo(): Promise<void> {
  let server: ChildProcess;
  try {
    server = spawn("centrifugo.exe", ["-c", join(repo, "chat-server", "centrifugo", "config.test.json")], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    console.log("chat client vs centrifugo: SKIPPED (centrifugo not on PATH)");
    return;
  }
  let spawnFailed = false;
  server.on("error", () => { spawnFailed = true; });
  try {
    let up = false;
    for (let i = 0; i < 40 && !up && !spawnFailed; i++) {
      await wait(250);
      try { up = (await fetch(`http://127.0.0.1:${CENTRIFUGO_PORT}/health`)).status < 500; } catch { /* not yet */ }
    }
    if (spawnFailed) { console.log("chat client vs centrifugo: SKIPPED (centrifugo not on PATH)"); return; }
    assert(up, "centrifugo never came up");

    const opts = (handle: string) => ({
      backend: "centrifugo" as const, url: `ws://127.0.0.1:${CENTRIFUGO_PORT}/connection/websocket`, handle, token: "",
    });
    const a = new ChatClient();
    const b = new ChatClient();
    const wa = connected(a); const wb = connected(b);
    a.configure(opts("SubTest"), true);
    b.configure(opts("WingmanTest"), true);
    await Promise.all([wa, wb]);

    // Give the subscribes a beat to land before publishing into the room.
    await until(a, (f) => f.type === "state" && f.view.channels.some((c: any) => c.ch === "global"), "A subscribed");
    await until(b, (f) => f.type === "state" && f.view.channels.some((c: any) => c.ch === "global"), "B subscribed");

    const heard = until(b, (f) => f.type === "msg" && f.msg.text === "hello via centrifugo", "B hears A via centrifugo");
    assert.equal(a.send("global", "hello via centrifugo").ok, true);
    const got = await heard;
    assert.equal(got.msg.from.handle, "SubTest");
    // The shallow arm really is shallow: no region/shard rooms.
    assert.equal(a.send("region:use1b", "nope").ok, false, "centrifugo arm only has global");

    a.configure(opts("SubTest"), false);
    b.configure(opts("WingmanTest"), false);
    console.log("chat client vs centrifugo: ok");
  } finally {
    server.kill();
  }
}

await testCustom();
await testCentrifugo();
console.log("chat client tests passed");
process.exit(0);

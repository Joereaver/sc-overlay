// ChatClient (the sidecar's half) against the real chat server (spawned here).
// Run: npx tsx src/chat.test.ts
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { ChatClient, regionLabel, shardLabel } from "./chat.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const CUSTOM_PORT = 8796;   // scratch — not 8788 (a dev chat server) nor 8778 (the sidecar)
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
      url: `ws://127.0.0.1:${CUSTOM_PORT}/ws`, handle, token: "",
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

await testCustom();
console.log("chat client tests passed");
// Let the closed sockets' libuv handles finish tearing down before exit — an immediate
// process.exit() races them on Windows and aborts (uv assert) AFTER the pass line prints.
setTimeout(() => process.exit(0), 250);

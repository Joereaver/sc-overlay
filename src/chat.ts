// Social chat client — the sidecar's HALF of the chat feature. The single backend
// connection lives HERE, not in the widget: widgets are iframes that reload on regroup and
// close with the canvas, so a widget-owned socket would drop scrollback and presence every
// time. The widget talks to this module over the existing SSE + POST pattern.
//
// Backend: chat-server/server.mjs (self-hosted) — 3-tier channels, history, bans. A Centrifugo
// arm was A/B-tested on 2026-08-08 and retired the same day (Sub's call: same product work
// either way, one more service to run, and it needed a local-echo workaround — see git history
// for the adapter).
//
// The channel hierarchy:
//   global                 everyone on the app
//   region:use1b           "the server" in player speak — the region/AZ from the shard id
//   shard:pub_use1b_…_040  the actual universe instance — people you can meet
// Region + shard membership follow the Game.log (`Join PU` / `Update Shard Id` → the parser's
// `shard` event → applyShard here). Leaving the PU drops both, keeps global.
//
// Resource rule: NO connection unless the Chat widget is actually open (chatOpen) — closed
// widget = zero sockets, zero timers beyond nothing. History survives in this process across
// widget open/close within a run.

import { EventEmitter } from "node:events";
import { regionOfShard } from "./missions-parser.js";

export interface ChatIdentity { handle: string; verified: boolean }
export interface ChatMsg {
  ch: string;
  id: number | string;
  from: ChatIdentity;
  text: string;
  at: string;
}
export type ChatStatus = "off" | "connecting" | "connected" | "error";

export interface ChatOptions {
  url: string;          // ws:// or wss:// endpoint of the chat server
  handle: string;       // dev-mode identity; production auth is the sync token
  token: string;        // overlay sync token (site-mode auth on the chat server)
}

interface ChannelState {
  ch: string;
  kind: "global" | "region" | "shard";
  label: string;
  count: number | null; // unique handles, when the backend reports presence
  msgs: ChatMsg[];
}

const HISTORY_KEEP = 200;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];

/** "use1b" → "US East 1B" — the label players recognise. Unknown codes pass through raw. */
export function regionLabel(region: string | null): string {
  if (!region) return "Server";
  const m = region.toLowerCase().match(/^(use|usw|eue|euw|apse|apne|aps|apn)(\d+)([a-z])$/);
  if (!m) return region.toUpperCase();
  const NAMES: Record<string, string> = {
    use: "US East", usw: "US West", eue: "EU East", euw: "EU West",
    apse: "Asia SE", apne: "Asia NE", aps: "Asia S", apn: "Asia N",
  };
  return `${NAMES[m[1]] ?? m[1].toUpperCase()} ${m[2]}${m[3].toUpperCase()}`;
}

/** "pub_use1b_12326004_040" → "Shard 040". */
export function shardLabel(shard: string | null): string {
  if (!shard) return "Shard";
  const seg = shard.split("_");
  return `Shard ${seg[seg.length - 1] ?? shard}`;
}

export class ChatClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private opts: ChatOptions | null = null;
  private active = false;      // widget open + feature on → we want a connection
  private status: ChatStatus = "off";
  private lastError: string | null = null;
  private you: ChatIdentity | null = null;
  private shard: string | null = null; // full id from the log; region derives from it
  private channels = new Map<string, ChannelState>();
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private closingDeliberately = false;
  private cfgId = 0; // guards a stale socket's callbacks after reconfigure

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** (Re)configure and set whether a connection is WANTED. Safe to call repeatedly with the
   *  same values — only a real change tears the socket down. */
  configure(opts: ChatOptions, active: boolean): void {
    const changed = JSON.stringify(this.opts) !== JSON.stringify(opts);
    this.opts = opts;
    if (changed || active !== this.active) {
      this.active = active;
      this.teardown();
      // A DIFFERENT backend/identity is a different world — its channels and scrollback don't
      // carry over (a dead "Shard" tab with another server's history is worse than none).
      // Merely closing the widget (active=false, opts unchanged) keeps history on purpose.
      if (changed) this.channels.clear();
      if (this.active) this.connect();
      else { this.status = "off"; this.pushState(); }
    }
  }

  /** The parser saw a shard change (null = left the PU). Region/shard channels follow. */
  applyShard(shard: string | null): void {
    if (shard === this.shard) return;
    this.shard = shard;
    this.sendLoc();
    this.pushState(); // labels update even while disconnected
  }

  private teardown(): void {
    this.cfgId++;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.ws) {
      this.closingDeliberately = true;
      try { this.ws.close(); } catch { /* already closed */ }
      this.ws = null;
    }
    this.retry = 0;
    this.you = null;
  }

  private connect(): void {
    if (!this.opts || !this.active) return;
    const id = ++this.cfgId;
    this.status = "connecting";
    this.lastError = null;
    this.pushState();
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url);
    } catch (e) {
      this.fail(String((e as Error).message ?? e), id);
      return;
    }
    this.ws = ws;
    this.closingDeliberately = false;
    ws.onopen = () => {
      if (id !== this.cfgId) return;
      this.wsSend({ t: "hello", token: this.opts!.token, handle: this.opts!.handle });
    };
    ws.onmessage = (e) => {
      if (id !== this.cfgId) return;
      let f: any;
      try { f = JSON.parse(String(e.data)); } catch { return; }
      this.onFrame(f);
    };
    ws.onclose = () => {
      if (id !== this.cfgId) return;
      this.ws = null;
      if (this.closingDeliberately) return;
      this.fail(this.lastError ?? "connection lost", id);
    };
    ws.onerror = () => { /* onclose always follows and carries the retry */ };
  }

  private fail(message: string, id: number): void {
    if (id !== this.cfgId || !this.active) return;
    this.status = "error";
    this.lastError = message;
    this.pushState();
    const delay = BACKOFF_MS[Math.min(this.retry++, BACKOFF_MS.length - 1)];
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, delay);
  }

  private wsSend(frame: unknown): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(frame));
  }

  private sendLoc(): void {
    if (this.status !== "connected") return;
    this.wsSend({ t: "loc", region: regionOfShard(this.shard), shard: this.shard });
  }

  // ── The chat-server protocol (chat-server/server.mjs) ─────────────────────

  private onFrame(f: any): void {
    switch (f.t) {
      case "welcome":
        this.status = "connected";
        this.retry = 0;
        this.you = f.you ?? null;
        this.sendLoc();
        this.pushState();
        return;
      case "joined":
        this.ensureChannel(f.ch);
        this.pushState();
        return;
      case "left":
        this.channels.delete(f.ch);
        this.pushState();
        return;
      case "history": {
        const c = this.ensureChannel(f.ch);
        if (Array.isArray(f.msgs)) c.msgs = f.msgs.slice(-HISTORY_KEEP);
        this.pushState();
        return;
      }
      case "msg":
        this.pushMsg({ ch: f.ch, id: f.id, from: f.from, text: f.text, at: f.at });
        return;
      case "presence": {
        const c = this.channels.get(f.ch);
        if (c) { c.count = f.count; this.emit("sse", { type: "presence", ch: f.ch, count: f.count }); }
        return;
      }
      case "error":
        // banned / bad_auth close the socket right after; surface the reason, don't hammer.
        this.lastError = f.message ?? f.code ?? "chat error";
        if (f.code === "banned" || f.code === "bad_auth") this.retry = BACKOFF_MS.length - 1;
        this.emit("sse", { type: "notice", level: "error", text: this.lastError });
        return;
    }
  }

  // ── Shared state plumbing ─────────────────────────────────────────────────

  private ensureChannel(ch: string): ChannelState {
    let c = this.channels.get(ch);
    if (!c) {
      const kind = ch === "global" ? "global" : ch.startsWith("region:") ? "region" : "shard";
      c = { ch, kind, label: this.labelFor(ch, kind), count: null, msgs: [] };
      this.channels.set(ch, c);
    }
    return c;
  }

  private labelFor(ch: string, kind: ChannelState["kind"]): string {
    if (kind === "global") return "Global";
    if (kind === "region") return regionLabel(ch.slice("region:".length));
    return shardLabel(ch.slice("shard:".length));
  }

  private pushMsg(msg: ChatMsg): void {
    const c = this.ensureChannel(msg.ch);
    c.msgs.push(msg);
    if (c.msgs.length > HISTORY_KEEP) c.msgs.splice(0, c.msgs.length - HISTORY_KEEP);
    this.emit("sse", { type: "msg", msg });
  }

  private pushState(): void {
    this.emit("sse", { type: "state", view: this.view() });
  }

  // ── Public API (the sidecar's HTTP layer calls these) ─────────────────────

  send(ch: string, text: string): { ok: boolean; message?: string } {
    if (this.status !== "connected") return { ok: false, message: "Chat is not connected." };
    const t = text.trim();
    if (!t) return { ok: false, message: "Empty message." };
    this.wsSend({ t: "msg", ch, text: t });
    return { ok: true };
  }

  /** Widget bootstrap + /api/chat/state. Channel order is the fixed hierarchy. */
  view() {
    const order = { global: 0, region: 1, shard: 2 } as const;
    const channels = [...this.channels.values()]
      .sort((a, b) => order[a.kind] - order[b.kind] || a.ch.localeCompare(b.ch))
      .map((c) => ({ ch: c.ch, kind: c.kind, label: c.label, count: c.count, msgs: c.msgs }));
    return {
      status: this.status,
      error: this.lastError,
      you: this.you,
      shard: this.shard,
      region: regionOfShard(this.shard),
      regionLabel: regionLabel(regionOfShard(this.shard)),
      shardLabel: shardLabel(this.shard),
      channels,
    };
  }
}

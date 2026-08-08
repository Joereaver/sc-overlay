// Social chat client — the sidecar's HALF of the chat feature. The single backend
// connection lives HERE, not in the widget: widgets are iframes that reload on regroup and
// close with the canvas, so a widget-owned socket would drop scrollback and presence every
// time. The widget talks to this module over the existing SSE + POST pattern.
//
// Two backends, A/B-tested (Sub, 2026-08-08):
//   "custom"      chat-server/server.mjs — full protocol: 3-tier channels, history, bans.
//   "centrifugo"  a self-hosted Centrifugo instance — deliberately SHALLOW (one global room)
//                 per Sub's "don't get too deep" instruction. Live messages only.
//
// The channel hierarchy (custom backend):
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
  backend: "custom" | "centrifugo";
  url: string;          // ws:// or wss:// endpoint of the chosen backend
  handle: string;       // dev-mode identity; production auth is the sync token
  token: string;        // overlay sync token (site-mode auth on the custom server)
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
      if (this.opts!.backend === "custom") {
        this.wsSend({ t: "hello", token: this.opts!.token, handle: this.opts!.handle });
      } else {
        // Centrifugo connect frame (JSON protocol). Insecure/dev mode needs no token.
        this.wsSend({ id: 1, connect: { name: "sc-overlay" } });
      }
    };
    ws.onmessage = (e) => {
      if (id !== this.cfgId) return;
      let f: any;
      try { f = JSON.parse(String(e.data)); } catch { return; }
      if (this.opts!.backend === "custom") this.onCustomFrame(f);
      else this.onCentrifugoFrame(f);
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
    if (this.status !== "connected" || this.opts?.backend !== "custom") return;
    this.wsSend({ t: "loc", region: regionOfShard(this.shard), shard: this.shard });
  }

  // ── Custom backend (chat-server/server.mjs protocol) ──────────────────────

  private onCustomFrame(f: any): void {
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

  // ── Centrifugo backend — ONE global room, live messages only (the A/B scope) ──
  // Minimal JSON client protocol: {id,connect}/{id,subscribe}/{id,publish} requests,
  // {push:{channel,pub:{data}}} deliveries, and {} pings we must echo back.

  private onCentrifugoFrame(f: any): void {
    // Server ping is an EMPTY frame; echo it or the server drops us after a timeout.
    if (f && typeof f === "object" && Object.keys(f).length === 0) { this.wsSend({}); return; }
    if (f.id === 1 && f.connect) {
      this.status = "connected";
      this.retry = 0;
      // No server-side identity in insecure mode: the client stamps its own handle. Fine for
      // a local A/B; a production pick of this backend gets JWTs minted by the site instead.
      this.you = { handle: this.opts?.handle || "anon", verified: true };
      this.wsSend({ id: 2, subscribe: { channel: "sc-global" } });
      return;
    }
    if (f.id === 2 && f.subscribe) {
      const c = this.ensureChannel("global");
      const pubs = f.subscribe.publications;
      if (Array.isArray(pubs)) {
        c.msgs = pubs.map((p: any) => this.centrifugoMsg(p)).filter(Boolean).slice(-HISTORY_KEEP) as ChatMsg[];
      }
      this.pushState();
      return;
    }
    if (f.push?.pub) {
      const msg = this.centrifugoMsg(f.push.pub);
      if (msg) this.pushMsg(msg);
      return;
    }
    if (f.error) {
      this.lastError = `centrifugo: ${f.error.message ?? f.error.code}`;
      this.emit("sse", { type: "notice", level: "error", text: this.lastError });
    }
  }

  private centrifugoSeq = 0;
  /** Nonces of OUR recent centrifugo publishes. Centrifugo does not deliver a publication back
   *  to the connection that published it (measured on the live instance, 2026-08-08 — everyone
   *  else heard the message, the sender never did), so send() echoes locally; this set is the
   *  guard that keeps the message single if a server echo ever DOES arrive. */
  private sentNonces = new Set<string>();
  private centrifugoMsg(pub: any): ChatMsg | null {
    const d = pub?.data;
    if (!d || typeof d.text !== "string") return null;
    if (typeof d.n === "string" && this.sentNonces.has(d.n)) return null; // our own, already echoed
    return {
      ch: "global",
      id: pub.offset ?? `c${++this.centrifugoSeq}`,
      from: { handle: String(d.handle ?? "anon"), verified: d.verified === true },
      text: d.text,
      at: String(d.at ?? new Date().toISOString()),
    };
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
    if (this.opts?.backend === "custom") {
      this.wsSend({ t: "msg", ch, text: t });
    } else {
      if (ch !== "global") return { ok: false, message: "The Centrifugo A/B build only has Global chat." };
      const at = new Date().toISOString();
      const n = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      this.sentNonces.add(n);
      if (this.sentNonces.size > 50) this.sentNonces.delete(this.sentNonces.values().next().value!);
      this.wsSend({
        id: 100 + ++this.centrifugoSeq,
        publish: { channel: "sc-global", data: { handle: this.you?.handle, verified: this.you?.verified === true, text: t, at, n } },
      });
      // Local echo — the server won't reflect it to us (see sentNonces above).
      this.pushMsg({ ch: "global", id: `local-${n}`, from: this.you ?? { handle: "?", verified: false }, text: t, at });
    }
    return { ok: true };
  }

  /** Widget bootstrap + /api/chat/state. Channel order is the fixed hierarchy. */
  view() {
    const order = { global: 0, region: 1, shard: 2 } as const;
    const channels = [...this.channels.values()]
      .sort((a, b) => order[a.kind] - order[b.kind] || a.ch.localeCompare(b.ch))
      .map((c) => ({ ch: c.ch, kind: c.kind, label: c.label, count: c.count, msgs: c.msgs }));
    return {
      backend: this.opts?.backend ?? "custom",
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

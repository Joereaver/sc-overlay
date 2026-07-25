/**
 * Party roster + reward-split state for the Party widget.
 *
 * 🔑 game.log CANNOT name your party members live. Verified against real multi-party sessions:
 * the only party lines the client writes are
 *   <CPartyMarkerComponent RWES/UFES> Streamed in/out party marker id <n>. TrackedEntityId: <n>
 * which carry an entity id and no handle, plus the marker's DETACH line
 *   ...force detaching ENTITY ATTACHMENT ... "PartyMemberMarker_<n>" ... parent id = <n> name = "<handle>"
 * which does name the player — but only fires when they despawn, so it lands late or never.
 * (An "Actor stall detected, Player: <handle>" line names people incidentally; too flaky to use.)
 *
 * So the roster is MANUAL and the log only assists:
 *   - live party SIZE from the marker set → "3 detected, 2 named" nudge,
 *   - handles harvested from detach lines → one-tap suggestions, persisted across sessions
 *     so someone you've played with once is always one tap away.
 *
 * The split itself is plain arithmetic over the shares the user sets; this module owns the
 * roster's persistence and normalization, and the widget renders the cuts.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MissionEvent } from "./missions-parser.js";

/** The player's own handle, straight from the log. Same lines log-scrub keys on:
 *  `<CharacterStatus> ... name <handle>` and `Handle[<handle>]`. */
const RE_OWN_HANDLE = [/AccountLoginCharacterStatus_Character[^\n]*?name\s+([A-Za-z0-9_-]{2,40})/, /Handle\[([A-Za-z0-9_-]{2,40})\]/];
export function ownHandleFromLog(raw: string): string {
  for (const re of RE_OWN_HANDLE) { const m = raw.match(re); if (m) return m[1]; }
  return "";
}

export interface PartyMember {
  id: string;
  name: string;
  /** Percentage of a payout this member takes. The widget nudges toward a total of 100. */
  share: number;
}

/** A saved split, written to disk so it survives the app closing. The whole point: a mining crew
 *  splits ore they will not SELL until a later session, so the numbers have to be recoverable
 *  after the app (and the game) have been restarted. Each save also writes a plain-text copy
 *  next to the JSON so it can be read, printed or pasted into Discord without the app. */
/** A thing being divided. The game already splits mission aUEC, so what a crew actually divides
 *  is the PROCEEDS: SCU of ore, salvage, boxes of cargo. `unit` is free text ("SCU", "units",
 *  "boxes"), and `pricePerUnit` is optional — set it and the split also reports what each share is
 *  WORTH, so people can be paid out before the ore is ever sold. */
export interface LootItem {
  id: string;
  name: string;
  qty: number;
  unit: string;
  pricePerUnit: number | null;
}

export interface PartySession {
  id: string;
  label: string;
  savedAt: string;
  /** Cash pot being split (aUEC), or null when the split is purely in goods. */
  pot: number | null;
  potLabel: string;
  /** The goods being divided, if any. */
  loot: LootItem[];
  members: (PartyMember & { cut: number | null; lootCuts?: { name: string; qty: number; unit: string; value: number | null }[] })[];
}

export interface PartyView {
  members: PartyMember[];
  /** The signed-in player's own handle, so the widget can seed them into the roster. */
  self: string;
  /** Saved sessions, newest first. */
  sessions: { id: string; label: string; savedAt: string; pot: number | null; members: number }[];
  /** Party markers currently streamed in = how many party members the game is tracking. */
  detected: number;
  /** Handles seen in this or a past session, newest first — roster autocomplete. */
  suggestions: string[];
}

interface Persisted {
  members?: PartyMember[];
  suggestions?: string[];
}

const MAX_MEMBERS = 12;
const MAX_LOOT = 24;

/** Normalize the loot lines the widget posts. Quantities are allowed to be fractional (SCU
 *  often is); a blank price just means "goods only, no cash value known". */
function sanitizeLoot(raw: unknown): LootItem[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
    .map((l, i) => ({
      id: typeof l.id === "string" && l.id ? l.id : `l${i}`,
      name: String(l.name ?? "").trim().slice(0, 60),
      qty: Math.max(0, Number(l.qty) || 0),
      unit: String(l.unit ?? "SCU").trim().slice(0, 12) || "SCU",
      pricePerUnit: l.pricePerUnit == null || l.pricePerUnit === "" ? null : Math.max(0, Number(l.pricePerUnit) || 0),
    }))
    .filter((l) => l.name)
    .slice(0, MAX_LOOT);
}
const MAX_SUGGESTIONS = 24;

/** Names that come off marker-detach lines are player handles, but the same log shape is used
 *  for engine objects; keep anything that looks like a handle and drop obvious internals. */
function looksLikeHandle(name: string): boolean {
  if (!name || name.length > 40) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) return false;
  return !/^(StreamingSOC|OOC|SolarSystem|PU_|Hangar|ObjectContainer)/i.test(name);
}

export class PartyTracker {
  private members: PartyMember[] = [];
  private suggestions: string[] = [];
  /** Marker ids currently streamed in. Per-session, never persisted. */
  private markers = new Set<string>();
  private saveTimer: NodeJS.Timeout | null = null;
  private sessions: PartySession[] = [];
  /** The player's own handle (set once the log has been read). */
  private self = "";

  constructor(private readonly file: string, private readonly sessionDir: string) {
    this.load();
    this.loadSessions();
  }

  // ── saved sessions ─────────────────────────────────────────────────────────
  private loadSessions(): void {
    try {
      if (!existsSync(this.sessionDir)) return;
      const out: PartySession[] = [];
      for (const f of readdirSync(this.sessionDir)) {
        if (!f.endsWith(".json")) continue;
        try { out.push(JSON.parse(readFileSync(join(this.sessionDir, f), "utf8")) as PartySession); }
        catch { /* skip an unreadable snapshot rather than losing the rest */ }
      }
      out.sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
      this.sessions = out;
    } catch {
      this.sessions = [];
    }
  }

  /** Human-readable twin of the JSON — this is the file a crew actually opens days later. */
  private renderText(s: PartySession): string {
    const when = new Date(s.savedAt).toLocaleString();
    const lines = [
      "SC Overlay - party split",
      "=".repeat(34),
      s.label,
      "Saved: " + when,
      s.pot != null ? s.potLabel + ": " + Math.round(s.pot).toLocaleString() + " aUEC" : s.potLabel + ": (not recorded)",
      "",
    ];
    const w = Math.max(6, ...s.members.map((m) => m.name.length));
    for (const m of s.members) {
      lines.push(
        m.name.padEnd(w) + "  " + String(m.share).padStart(5) + "%  " +
        (m.cut != null ? Math.round(m.cut).toLocaleString().padStart(12) + " aUEC" : "".padStart(12) + "     "),
      );
    }
    lines.push("");
    lines.push("Shares total " + s.members.reduce((t, m) => t + (Number(m.share) || 0), 0) + "%");
    return lines.join("\r\n") + "\r\n";
  }

  async saveSession(raw: unknown): Promise<PartySession> {
    const b = (raw ?? {}) as Record<string, unknown>;
    const pot = typeof b.pot === "number" && isFinite(b.pot) ? b.pot : null;
    const members: PartySession["members"] = this.setMembers(b.members ?? this.members).map((m) => ({
      ...m,
      cut: pot != null ? Math.round((pot * m.share) / 100) : null,
    }));
    const loot = sanitizeLoot(b.loot);
    // Each member's share of every loot line, plus its cash value when a unit price is known.
    for (const m of members) {
      m.lootCuts = loot.map((l) => ({
        name: l.name,
        qty: Math.round(((l.qty * m.share) / 100) * 100) / 100,
        unit: l.unit,
        value: l.pricePerUnit != null ? Math.round(((l.qty * m.share) / 100) * l.pricePerUnit) : null,
      }));
    }
    const savedAt = new Date().toISOString();
    const session: PartySession = {
      id: savedAt.replace(/[:.]/g, "-"),
      label: String(b.label ?? "").trim().slice(0, 80) || "Session " + savedAt.slice(0, 16).replace("T", " "),
      savedAt,
      pot,
      potLabel: String(b.potLabel ?? "Pot").slice(0, 40),
      loot,
      members,
    };
    try {
      await mkdir(this.sessionDir, { recursive: true });
      await writeFile(join(this.sessionDir, session.id + ".json"), JSON.stringify(session, null, 2));
      await writeFile(join(this.sessionDir, session.id + ".txt"), this.renderText(session));
    } catch {
      /* disk trouble: still return it so the widget can show the split it just computed */
    }
    this.sessions.unshift(session);
    await this.writeIndex();
    return session;
  }

  getSession(id: string): PartySession | null {
    return this.sessions.find((s) => s.id === id) ?? null;
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions = this.sessions.filter((s) => s.id !== id);
    for (const ext of [".json", ".txt"]) {
      try { await unlink(join(this.sessionDir, id + ext)); } catch { /* already gone */ }
    }
    await this.writeIndex();
  }

  sessionFolder(): string { return this.sessionDir; }

  /** Rewrite index.html - a self-contained browser view of every saved split. Regenerated on
   *  each save/delete so it never goes stale. Data is inlined, so it works straight off disk
   *  with no server and no network. */
  private async writeIndex(): Promise<void> {
    const data = JSON.stringify(this.sessions).replace(/</g, "\\u003c");
    const html = `<!doctype html>
<meta charset="utf-8"><title>SC Overlay - saved party splits</title>
<style>
 :root{--bg:#0b1119;--pan:#101a24;--line:#1e3242;--cy:#45D0E0;--go:#FFD27A;--tx:#c4dbe6;--dim:#7fa7bb;--faint:#5d7e90}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.5 Inter,system-ui,sans-serif;padding:28px}
 h1{font-size:16px;letter-spacing:.18em;text-transform:uppercase;color:var(--cy);margin:0 0 4px}
 .sub{color:var(--faint);font-size:12px;margin-bottom:22px}
 .card{background:var(--pan);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-bottom:14px;max-width:820px}
 .ch{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px}
 .ch b{font-size:15px;color:var(--cy)}
 .ch .w{color:var(--faint);font-size:12px;font-family:ui-monospace,Consolas,monospace}
 .ch .p{margin-left:auto;color:var(--go);font-family:ui-monospace,Consolas,monospace;font-weight:600}
 table{border-collapse:collapse;width:100%;font-size:13px}
 th{text-align:left;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);
    font-weight:700;padding:4px 8px 4px 0;border-bottom:1px solid var(--line)}
 td{padding:5px 8px 5px 0;border-bottom:1px solid rgba(69,208,224,.08)}
 td.n{font-weight:600;color:#e6f2f7}
 td.num{text-align:right;font-family:ui-monospace,Consolas,monospace}
 td.cut{text-align:right;font-family:ui-monospace,Consolas,monospace;color:var(--go);font-weight:600}
 .loot{margin-top:10px;font-size:12px;color:var(--dim)}
 .loot span{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 9px;margin:3px 5px 0 0}
 .empty{color:var(--faint)}
</style>
<h1>Saved party splits</h1>
<div class="sub">SC Overlay &middot; this file regenerates whenever a split is saved. The matching .json and .txt files sit in this folder.</div>
<div id="out"></div>
<script>
const S=${data};
const n=v=>Math.round(v).toLocaleString();
const out=document.getElementById("out");
if(!S.length){out.innerHTML='<div class="empty">No splits saved yet.</div>';}
for(const s of S){
  const d=document.createElement("div");d.className="card";
  const h=document.createElement("div");h.className="ch";
  const b=document.createElement("b");b.textContent=s.label;
  const w=document.createElement("span");w.className="w";w.textContent=new Date(s.savedAt).toLocaleString();
  h.append(b,w);
  if(s.pot!=null){const p=document.createElement("span");p.className="p";p.textContent=(s.potLabel||"Pot")+": "+n(s.pot)+" aUEC";h.append(p);}
  d.append(h);
  const hasCash=s.pot!=null, loot=s.loot||[];
  const t=document.createElement("table");
  const cols=["Member","Share"].concat(hasCash?["Cut"]:[]).concat(loot.map(l=>l.name));
  t.innerHTML="<tr>"+cols.map(c=>"<th>"+c+"</th>").join("")+"</tr>";
  for(const m of s.members){
    const tr=document.createElement("tr");
    let html='<td class="n">'+m.name+'</td><td class="num">'+m.share+'%</td>';
    if(hasCash) html+='<td class="cut">'+(m.cut!=null?n(m.cut)+" aUEC":"\u2014")+'</td>';
    for(const l of loot){
      const c=(m.lootCuts||[]).find(x=>x.name===l.name);
      html+='<td class="cut">'+(c?c.qty+" "+c.unit+(c.value!=null?" ("+n(c.value)+" aUEC)":""):"\u2014")+'</td>';
    }
    tr.innerHTML=html;t.append(tr);
  }
  d.append(t);
  if(loot.length){
    const l=document.createElement("div");l.className="loot";
    l.innerHTML="Total haul: "+loot.map(x=>"<span>"+x.qty+" "+x.unit+" "+x.name+(x.pricePerUnit!=null?" @ "+n(x.pricePerUnit)+"/"+x.unit:"")+"</span>").join("");
    d.append(l);
  }
  out.append(d);
}
</script>`;
    try { await writeFile(join(this.sessionDir, "index.html"), html); }
    catch { /* best-effort */ }
  }

  private load(): void {
    try {
      if (!existsSync(this.file)) return;
      const data = JSON.parse(readFileSync(this.file, "utf8")) as Persisted;
      this.members = (data.members ?? []).filter((m) => m && typeof m.name === "string").slice(0, MAX_MEMBERS);
      this.suggestions = (data.suggestions ?? []).filter((s) => typeof s === "string").slice(0, MAX_SUGGESTIONS);
    } catch {
      /* corrupt or unreadable — start empty rather than crash the sidecar */
    }
  }

  /** Debounced so a burst of harvested names doesn't write the file repeatedly. */
  private save(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void (async () => {
        try {
          await mkdir(dirname(this.file), { recursive: true });
          await writeFile(this.file, JSON.stringify({ members: this.members, suggestions: this.suggestions }, null, 2));
        } catch {
          /* best-effort: the roster is a convenience, never worth taking the server down for */
        }
      })();
    }, 400);
  }

  apply(ev: MissionEvent): void {
    switch (ev.kind) {
      case "partyMarker":
        if (ev.present) this.markers.add(ev.markerId);
        else this.markers.delete(ev.markerId);
        break;
      case "partyMemberName":
        this.remember(ev.name);
        break;
      // Party membership is per-connection like everything else the tracker holds.
      case "sessionStart":
      case "sessionEnd":
        this.markers.clear();
        break;
      default:
        break;
    }
  }

  /** Record a handle as a roster suggestion (newest first, deduped case-insensitively). */
  private remember(name: string): void {
    if (!looksLikeHandle(name)) return;
    const lower = name.toLowerCase();
    const next = this.suggestions.filter((s) => s.toLowerCase() !== lower);
    next.unshift(name);
    this.suggestions = next.slice(0, MAX_SUGGESTIONS);
    this.save();
  }

  /** Learn the player's own handle from the log so the roster can pre-fill them. */
  setSelf(handle: string): void {
    if (handle && handle !== this.self) { this.self = handle; this.remember(handle); }
  }

  /** Replace the roster (the widget owns editing and posts the whole list). */
  setMembers(raw: unknown): PartyMember[] {
    const list = Array.isArray(raw) ? raw : [];
    this.members = list
      .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
      .map((m, i) => ({
        id: typeof m.id === "string" && m.id ? m.id : `m${i}-${Date.now().toString(36)}`,
        name: String(m.name ?? "").trim().slice(0, 40),
        share: Math.max(0, Math.min(100, Number(m.share) || 0)),
      }))
      .filter((m) => m.name)
      .slice(0, MAX_MEMBERS);
    this.save();
    return this.members;
  }

  view(): PartyView {
    return {
      members: this.members,
      self: this.self,
      sessions: this.sessions.map((s) => ({ id: s.id, label: s.label, savedAt: s.savedAt, pot: s.pot, members: s.members.length })),
      detected: this.markers.size,
      suggestions: this.suggestions,
    };
  }
}

// Opt-in log sharing. When enabled (config.shareLogs) and a sync token is set, the
// current Star Citizen Game.log is scrubbed (src/log-scrub) and uploaded to subliminal.gg
// so mission + blueprint parsing can be improved against real sessions. Deduped by the
// scrubbed content's hash so the periodic tick never re-posts an unchanged session.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { scrubGameLog } from "./log-scrub.js";

const SITE = "https://subliminal.gg";
// The site rejects a body over 4MB (and an empty one) with a bare 400. A long session's
// game.log goes well past that, so trim to the most RECENT 4MB rather than posting something
// that can only be refused — the tail is the part that describes what the player just did.
const MAX_BYTES = 4 * 1024 * 1024;
let lastHash = "";

/** Keep the last `max` bytes, cut at a line boundary so the upload never starts mid-record. */
function tail(text: string, max: number): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text;
  const cut = text.slice(-max);
  const nl = cut.indexOf("\n");
  return nl >= 0 ? cut.slice(nl + 1) : cut;
}

export interface LogShareConfig {
  shareLogs: boolean;
  syncToken: string;
  logPath: string;
}

/** Best-effort: never throws. Uploads only when sharing is on, a token is set, and the
 *  scrubbed content changed since the last upload. */
export async function maybeShareLog(cfg: LogShareConfig, appVersion = ""): Promise<void> {
  try {
    if (!cfg.shareLogs || !cfg.syncToken) return;
    const raw = readFileSync(cfg.logPath, "utf8");
    if (!raw.trim()) return;
    const scrubbed = scrubGameLog(raw).text;
    const text = tail(scrubbed, MAX_BYTES);
    const bytes = Buffer.byteLength(text, "utf8");
    // Nothing survived the scrub: skip rather than spend a request the site must refuse.
    if (bytes === 0) {
      console.error(`[log-share] nothing to upload — ${raw.length} chars scrubbed to 0 (${cfg.logPath})`);
      return;
    }
    const hash = createHash("sha1").update(text).digest("hex");
    if (hash === lastHash) return;
    const res = await fetch(`${SITE}/api/bp-tracker/logs?v=${encodeURIComponent(appVersion)}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Authorization: `Bearer ${cfg.syncToken}` },
      body: text,
    });
    if (res.ok) {
      lastHash = hash;
      const trimmed = bytes < Buffer.byteLength(scrubbed, "utf8") ? ", tail only" : "";
      console.log(`[log-share] uploaded scrubbed Game.log (${bytes} bytes${trimmed})`);
    } else {
      // A bare status told us nothing when this fired for real — say what was sent and what
      // the site said back, so the next one doesn't need an investigation.
      const why = await res.text().catch(() => "");
      console.error(`[log-share] upload rejected: ${res.status} ${why.slice(0, 200)} (sent ${bytes} bytes as ${appVersion || "unknown version"})`);
    }
  } catch (err) {
    console.error("[log-share] failed:", err);
  }
}

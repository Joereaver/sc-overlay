// SC Overlay chat — auto-moderation.
//
// Sub's plan, in his words: "a word list that auto-bans on match and notifies me, and I review
// and can unban. This isn't a live service, this is a free app, so there's going to be pretty
// much zero tolerance." Reports are the backstop; this is the thing that actually runs.
//
// 🔴 MATCH ON WORD BOUNDARIES, NEVER `includes()` — the Scunthorpe problem. Every other chat
// surface in Star Citizen is pseudonymous; this one is gated on an RSI-VERIFIED identity, which
// is the whole reason a ban here sticks. It is also the reason a false positive is expensive: it
// bans a real person by their real handle. `includes("ass")` fires on "class", "Cassius",
// "Grassland" and the ship called Cutlass.
//
// 🔑 A term's boundary is asserted with LOOKAROUNDS, not `\b`. `\b` is defined against `\w`, so
// it is simply wrong at either end of a term that does not start or end with a word character —
// on the list's one emoji (🖕) a `\b` guard would refuse to match it next to a letter, which is
// exactly where someone would put it. So each end is guarded only when the term's own character
// there is alphanumeric.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LIST = join(HERE, "wordlist.txt");

/** Read a word-list file into unique lowercase terms.
 *  `#` comments a line out, so reviewing the list is editing it rather than deleting from it —
 *  a term Sub decides against stays visible as a decision instead of vanishing. */
export function parseList(text) {
  const terms = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l && !l.startsWith("#"));
  return [...new Set(terms)];
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One alternation over every term. Literals only, so there is nothing here to backtrack.
 *  🔑 Longest first: the match is what gets REPORTED, and a moderator reading "ass" when the
 *  message actually contained a three-word phrase learns the wrong thing about their own list. */
export function buildMatcher(terms) {
  if (!terms.length) return null;
  const parts = [...terms].sort((a, b) => b.length - a.length).map((t) => {
    // Spaces in a term match any run of whitespace — the list has 124 multi-word phrases and
    // nobody types them with exactly one space.
    const body = esc(t).replace(/\s+/g, "\\s+");
    const lead = /^[a-z0-9]/.test(t) ? "(?<![a-z0-9])" : "";
    const tail = /[a-z0-9]$/.test(t) ? "(?![a-z0-9])" : "";
    return `${lead}${body}${tail}`;
  });
  return new RegExp(`(?:${parts.join("|")})`, "iu");
}

/** modes:
 *    "off"  — loaded but never consulted
 *    "flag" — the message is REFUSED and the event reaches moderation; nobody is banned
 *    "ban"  — the same, plus the sender is banned
 *
 *  🔑 The default is "off", and that is a deliberate interlock rather than indecision. The list
 *  ships as LDNOOBW verbatim — a published list nobody on this project has reviewed, carrying
 *  ordinary anatomical vocabulary ("anal", "ass", "sex") alongside actual slurs. Both other
 *  modes REFUSE the message, so either one is a visible behaviour change for real players the
 *  moment it deploys: on this list unedited, "that fight was ass" stops being sendable. Sub
 *  asked for a list to review; until he has, this stays dark and costs one env var to arm.
 *  Suggested order once he has pruned it: "flag" for a while (refuses + notifies, bans nobody),
 *  then "ban" — the same list judged against real traffic is a better basis than reading it.
 */
export function createAutomod({ file = DEFAULT_LIST, mode = "off", log = console } = {}) {
  let terms = [];
  try {
    terms = parseList(readFileSync(file, "utf8"));
  } catch (e) {
    // A missing list is not a reason to refuse to start — it means no auto-moderation, which is
    // exactly where this feature was yesterday. Say so loudly and carry on.
    log?.warn?.(`[automod] no word list at ${file} (${e?.message}) — auto-moderation is off`);
  }
  const re = buildMatcher(terms);
  const active = mode !== "off" && !!re;
  log?.log?.(`[automod] mode=${mode} terms=${terms.length} active=${active}`);
  return {
    mode,
    active,
    size: terms.length,
    /** @returns {{term: string}|null} */
    scan(text) {
      if (!active) return null;
      const m = re.exec(String(text ?? ""));
      return m ? { term: m[0].toLowerCase() } : null;
    },
  };
}

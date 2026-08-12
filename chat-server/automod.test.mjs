// Auto-moderation matcher — pure, offline, no server. Run with `node chat-server/automod.test.mjs`.
//
// 🔴 THE FALSE-POSITIVE CASES ARE THE POINT OF THIS FILE. Chat is gated on an RSI-VERIFIED
// identity, so a wrong match bans a real person by their real handle. Substring matching would
// pass a "does it catch bad words" test perfectly and still be unshippable.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseList, buildMatcher, createAutomod, DEFAULT_LIST } from "./automod.mjs";

let n = 0;
const ok = (cond, why) => { assert(cond, why); n++; };
const hits = (re, s) => re.test(s);

// ── Parsing ────────────────────────────────────────────────────────────────
{
  const terms = parseList(`
    # a comment
    Alpha
    alpha

      bravo charlie
    #disabled-term
  `);
  assert.deepEqual(terms, ["alpha", "bravo charlie"]); n++;
  ok(!terms.includes("disabled-term"), "a commented-out term is not loaded");
  ok(!terms.includes("# a comment"), "comment lines are dropped whole");
}

// ── Word boundaries — the Scunthorpe set ───────────────────────────────────
{
  const re = buildMatcher(["ass", "hell", "anal", "cum"]);
  ok(hits(re, "that fight was ass"), "a standalone term matches");
  ok(hits(re, "ASS"), "matching is case-insensitive");
  ok(hits(re, "wow, ass!"), "punctuation is a boundary");

  // Every one of these contains a listed term as a SUBSTRING and none of them is the word.
  for (const clean of [
    "class", "Cassius", "grassland", "bypass", "passenger", "Cutlass",   // ass
    "hello", "shell", "Michelle", "helluva",                             // hell
    "analysis", "analyse", "canal", "banal",                             // anal
    "cumulative", "circumstance", "document", "Scunthorpe",              // cum
  ]) ok(!hits(re, clean), `"${clean}" must not match`);

  ok(!hits(re, "assassin"), "a term twice over inside one word still does not match");
}

// ── Multi-word phrases ─────────────────────────────────────────────────────
{
  const re = buildMatcher(["alabama hot pocket", "two girls"]);
  ok(hits(re, "an alabama hot pocket"), "a phrase matches");
  ok(hits(re, "alabama    hot\thot".replace("hot\thot", "hot\tpocket")), "any run of whitespace between words");
  ok(!hits(re, "alabamahotpocket"), "a phrase does not match without its separators");
  ok(!hits(re, "two girlsx"), "the trailing boundary still applies to a phrase");
}

// ── Terms that are not word-shaped ─────────────────────────────────────────
{
  // 🔑 `\b` is defined against \w, so a `\b`-guarded emoji refuses to match beside a letter —
  // which is exactly where someone types it. Only alphanumeric ENDS get a boundary guard.
  const re = buildMatcher(["🖕", "s&m", "g-spot"]);
  ok(hits(re, "no🖕way"), "an emoji term matches with no whitespace around it");
  ok(hits(re, "🖕"), "and on its own");
  ok(hits(re, "into s&m"), "a term with an inner symbol matches");
  ok(hits(re, "the g-spot"), "a hyphenated term matches");
  ok(!hits(re, "gspot"), "and not without its hyphen");
}

// ── Longest match wins, because the match is what gets reported ────────────
{
  const re = buildMatcher(["ass", "smart ass"]);
  assert.equal("you smart ass".match(re)[0], "smart ass"); n++;
}

// ── Regex metacharacters in a term are literal ─────────────────────────────
{
  const re = buildMatcher(["c.t"]);
  ok(hits(re, "a c.t here"), "the literal term matches");
  ok(!hits(re, "a cat here"), "the dot is escaped, not a wildcard");
}

// ── An empty list is not a matcher that matches everything ─────────────────
{
  assert.equal(buildMatcher([]), null); n++;
}

// ── Modes ──────────────────────────────────────────────────────────────────
{
  const quiet = { log() {}, warn() {}, error() {} };
  const off = createAutomod({ mode: "off", log: quiet });
  assert.equal(off.active, false); n++;
  assert.equal(off.scan("ass"), null, "an off automod never matches"); n++;

  const flag = createAutomod({ mode: "flag", log: quiet });
  ok(flag.size > 300, "the shipped list loaded");
  ok(flag.active, "flag mode is active");

  // A missing list disables rather than throwing — no auto-moderation is where this feature
  // was yesterday, and refusing to boot over it would be worse than the gap.
  const gone = createAutomod({ file: "./no-such-list.txt", mode: "ban", log: quiet });
  assert.equal(gone.active, false); n++;
  assert.equal(gone.scan("anything"), null); n++;
}

// ── The SHIPPED list, against ordinary Star Citizen chat ───────────────────
// 🔑 Real sentences, not synthetic ones. This is the check that would have caught shipping a
// substring matcher: every line below contains a listed term inside a longer word.
{
  const am = createAutomod({ mode: "flag", log: { log() {} } });
  for (const line of [
    "anyone got a Cutlass Black for the deep space hit?",
    "running class 3 quantum, forming up now",
    "my analysis of the pool says 5 of 8",
    "the Scunthorpe run pays better",
    "hello o7 forming up at Everus",
    "circumstances changed, bailing on this one",
    "grassland biome, no rocks worth scanning",
    "documents are in the mobiGlas",
    "bypassing the shield generator",
    "Michelle is on the way",
  ]) ok(am.scan(line) === null, `clean line flagged: "${line}"`);

  // And it does still do its job. Taken from the list itself so the assertion cannot drift
  // from the file: the first single-word term long enough to be unambiguous.
  const terms = parseList(readFileSync(DEFAULT_LIST, "utf8"));
  const sample = terms.find((t) => !t.includes(" ") && t.length >= 8 && /^[a-z]+$/.test(t));
  assert(sample, "the shipped list has a single-word term to test with"); n++;
  assert.equal(am.scan(`you absolute ${sample} mate`)?.term, sample); n++;
}

// ── 🔴 THE SHIPPED LIST'S OWN FALSE-POSITIVE SURFACE ───────────────────────
// This block asserts the matcher WILL fire on ordinary Star Citizen chat, which is not a bug in
// the matcher — it is what LDNOOBW contains. It is written down as a test so the cost of arming
// AUTOMOD_MODE is a fact in the repo rather than a caveat in a message someone half-remembers.
// "need an escort" is close to the single most-typed sentence in an SC LFG channel.
//
// 🔑 When Sub prunes wordlist.txt, the terms he removes should come OUT of this array — a
// failure here after an edit means the list changed and this record didn't.
{
  const am = createAutomod({ mode: "flag", log: { log() {} } });
  const collisions = ["escort", "shit", "suck", "ass", "sex", "dick", "snatch", "tits", "hooker"];
  for (const w of collisions) ok(am.scan(`we need an ${w} here`)?.term === w, `list still carries "${w}"`);
  ok(am.scan("running deep space hit, need an escort")?.term === "escort",
    "an ordinary LFG sentence is a match on the unpruned list");
}

console.log(`automod tests passed (${n} assertions)`);

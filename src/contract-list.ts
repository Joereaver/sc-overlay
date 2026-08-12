// Reading the mobiGlas Contract Manager's OFFERS list.
//
// Why this exists: for the ~1,000 contracts the game marks CalculatedReward, the aUEC
// payout is computed server-side at accept time. It is not in the datacore (those rows
// carry reward="0"), there is no reward curve anywhere in the records, and the
// "Awarded N aUEC" line this app used to parse out of game.log is no longer emitted.
// Reading the board is the only way left to learn what a contract pays.
//
// 🔑 THE LIST ROUNDS AND THAT IS FINE. The board shows "63k", not 63,412 — Sub's call
// (2026-08-11): "the end user is not going to care about that extra $500." Exact figures
// would mean clicking into every contract, which nobody will do at scale. So values are
// tagged `rounded` and the site's median-plus-range display carries the imprecision
// honestly rather than pretending to a precision we don't have.
//
// 🔑 SOME ROWS SHOW A FEE, NOT A REWARD ("Fee:13500"). 101 contracts charge to accept and
// 87 of them have no fixed payout, so they are over-represented here — and read naively a
// COST becomes a REWARD, which is the worst possible error for this dataset. A fee row
// therefore yields kind:"fee" and NO payout, and its reward stays unknown.
//
// Structure, measured off a real 3440x1440 capture (tools/ocr-probe.mts over
// ScreenShot-2026-08-11_18-45-30-82C.jpg) rather than eyeballed:
//   category header   h≈21   left column, with a count in the right column
//   title line(s)     h≈15-18 left column, ONE or TWO lines (never three)
//   giver             h≈12-13 left column, directly under the title
//   amount            h≈16-18 right column, vertically centred on the row
// Text height is what separates a title from a giver; horizontal position is what
// separates either from the amount.
//
// ⚠️ THE PANEL IS DRAWN IN PERSPECTIVE, so the left edge DRIFTS down the list (x=728 at
// the top, x=684 at the bottom of the same capture). Nothing here may key off an absolute
// x, and a fixed left margin would silently drop the lower rows.

import type { OcrLine, OcrResult } from "./screen-read.js";

export type AmountKind = "payout" | "fee";

export interface ContractRow {
  /** The category the row sits under ("MERCENARY") — the mission TYPE, and one of the
   *  three keys used to match a row back to the dataset. Null above the first header. */
  category: string | null;
  /** Title as displayed: uppercased, with the game's placeholders already filled in. */
  title: string;
  /** The blue line under the title ("CITIZENS FOR PROSPERITY"). */
  giver: string | null;
  amount: number | null;
  kind: AmountKind | null;
  /** True when the amount came from a "63k"-style abbreviation, i.e. +/-500. */
  rounded: boolean;
  /** Vertical centre of the row in the captured frame. Used to dedup across scrolls and
   *  to order rows; never persisted. */
  y: number;
}

/** Text-height bands. Expressed as FRACTIONS OF THE FRAME HEIGHT so they survive a
 *  different resolution — the measured capture was 1440 tall, where a giver line is
 *  ~12px and a title ~16px. */
const GIVER_MAX_H = 13.5 / 1440;
const TITLE_MAX_H = 19 / 1440;

/** How far the left column's start may drift, as a fraction of the PANEL's width. The
 *  perspective skew moves it ~63px across a ~536px-wide panel in the reference capture,
 *  so 12% covers it with room while still excluding the amount column. */
const LEFT_COL_TOL = 0.12;

/** The offers panel within the captured frame, in pixels. */
export interface PanelRect { x: number; y: number; w: number; h: number }

/** "63k" -> 63000, "1.5k" -> 1500, "Fee:13500" -> 13500. Returns null for anything that
 *  isn't a money value, which is most of the HUD. */
export function parseAmount(raw: string): { amount: number; kind: AmountKind; rounded: boolean } | null {
  const t = raw.trim();
  // A fee is labelled outright, and the label is the ONLY thing distinguishing a cost
  // from a reward — the number itself looks identical.
  const fee = /^fee\s*[:.]?\s*([\d,.]+)\s*([km])?$/i.exec(t);
  const plain = /^([\d,.]+)\s*([km])?$/i.exec(t);
  const m = fee ?? plain;
  if (!m) return null;
  const digits = m[1].replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  let n = Number(digits);
  if (!Number.isFinite(n)) return null;
  const suffix = (m[2] ?? "").toLowerCase();
  const rounded = suffix === "k" || suffix === "m";
  if (suffix === "k") n *= 1_000;
  if (suffix === "m") n *= 1_000_000;
  n = Math.round(n);
  // A bare 1- or 2-digit number is a row count or a rank badge, not money. The smallest
  // real fee in the datacore is 250.
  if (n < 100) return null;
  return { amount: n, kind: fee ? "fee" : "payout", rounded };
}

/** Uppercase, collapse whitespace, drop the punctuation the game and our dataset disagree
 *  about. Used on both sides of a title comparison so the match isn't defeated by an
 *  apostrophe ("YANG'S" vs "Yang’s" — a straight quote against a curly one). */
export function normalizeTitle(s: string): string {
  return s
    .toUpperCase()
    .replace(/[‘’']/g, "")
    .replace(/[^A-Z0-9\[\] ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Split the OCR of a Contract Manager capture into rows.
 *
 *  Deliberately tolerant: it returns what it could read and leaves fields null rather
 *  than dropping a row. A row with a title and no amount is still useful (it proves the
 *  contract is on the board); a row with an amount and no title is not, and is discarded. */
export function parseContractList(ocr: OcrResult, region?: PanelRect): ContractRow[] {
  const giverMaxH = GIVER_MAX_H * ocr.h;
  const titleMaxH = TITLE_MAX_H * ocr.h;

  // 🔑 The caller passes the calibrated offers panel, exactly like the Mining Scanner's
  // scan box. Without it there is no honest way to tell the left column from the rest of
  // the HUD: the bottom nav ("CONTRACTS", "WALLET") and the "ACCEPTED (0/10)" header are
  // ordinary text at ordinary heights, and letting them into the column maths pushed the
  // amount boundary out past the amounts themselves — every row parsed with a null price.
  const inRegion = region
    ? ocr.lines.filter(
        (l) =>
          l.x + l.w > region.x &&
          l.x < region.x + region.w &&
          l.y + l.h > region.y &&
          l.y < region.y + region.h,
      )
    : ocr.lines;
  const panel = inRegion.filter((l) => l.text.trim().length > 0);
  if (!panel.length) return [];

  const panelWidth = region ? region.w : Math.max(...panel.map((l) => l.x + l.w)) - Math.min(...panel.map((l) => l.x));
  const leftEdge = Math.min(...panel.map((l) => l.x));

  // The left column is everything starting near the panel's left edge; its widest line is
  // the title column's extent, and anything beyond that is the amount. Derived from the
  // COLUMN rather than from all text, so a wide stray elsewhere in the region can't move
  // the boundary.
  const leftCol = panel.filter((l) => l.x <= leftEdge + panelWidth * LEFT_COL_TOL);
  if (!leftCol.length) return [];
  const amountX = Math.max(...leftCol.map((l) => l.x + l.w));

  const sorted = [...panel].sort((a, b) => a.y - b.y);
  const rows: ContractRow[] = [];
  let category: string | null = null;
  let pending: { titles: OcrLine[]; giver: OcrLine | null } | null = null;

  const flush = () => {
    if (!pending || !pending.titles.length) {
      pending = null;
      return;
    }
    const titles = pending.titles;
    const top = titles[0].y;
    const bottom = (pending.giver ?? titles[titles.length - 1]);
    const yEnd = bottom.y + bottom.h;
    // The amount belongs to whichever row's vertical span contains its centre. Matching
    // by span rather than by nearest-line is what keeps a two-line title from stealing
    // the neighbour's number.
    const amountLine = sorted.find((l) => {
      if (l.x < amountX) return false;
      const c = l.y + l.h / 2;
      return c >= top - l.h && c <= yEnd + l.h;
    });
    const parsed = amountLine ? parseAmount(amountLine.text) : null;
    rows.push({
      category,
      title: titles.map((t) => t.text.trim()).join(" ").replace(/\s+/g, " "),
      giver: pending.giver ? pending.giver.text.trim() : null,
      amount: parsed ? parsed.amount : null,
      kind: parsed ? parsed.kind : null,
      rounded: parsed ? parsed.rounded : false,
      y: Math.round((top + yEnd) / 2),
    });
    pending = null;
  };

  for (const l of sorted) {
    if (l.x > amountX) continue; // right column: counts and amounts, handled per row
    const text = l.text.trim();
    if (!text) continue;

    if (l.h > titleMaxH) {
      // Category header — closes whatever row was open and renames the group.
      flush();
      category = text.toUpperCase();
      continue;
    }
    if (l.h <= giverMaxH) {
      // Giver line. It terminates the row: the next title line starts a new one.
      if (pending) {
        pending.giver = l;
        flush();
      }
      continue;
    }
    // Title line. Two lines can belong to one title and the game never uses three, so a
    // third consecutive title line must be the next contract rather than a continuation.
    if (pending && pending.titles.length >= 2) flush();
    if (!pending) pending = { titles: [], giver: null };
    pending.titles.push(l);
  }
  flush();
  return rows;
}

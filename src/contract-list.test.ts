// Contract Manager list parsing, tested against a REAL capture.
//
// The fixture below is the verbatim output of tools/ocr-probe.mts over
// ScreenShot-2026-08-11_18-45-30-82C.jpg (3440x1440, Sub's own board, Mercenary
// expanded). Not hand-authored: a synthetic fixture would encode what I THINK the OCR
// returns, and every interesting property here — the height bands, the perspective drift
// in x, the fee row, the two-line titles — only shows up in the real thing.
//
//   npx tsx src/contract-list.test.ts

import { parseAmount, parseContractList, normalizeTitle } from "./contract-list.js";
import type { OcrResult } from "./screen-read.js";

let failures = 0;
function check(name: string, ok: boolean, extra = "") {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? "  — " + extra : ""}`);
}

// x, y, w, h, text — exactly as OCR returned them.
const RAW: [number, number, number, number, string][] = [
  [1520, 151, 199, 20, "ACCEPTED (0/10)"],
  [728, 243, 167, 21, "COLLECTION"],
  [737, 334, 129, 21, "DELIVERY"],
  [743, 423, 204, 21, "INVESTIGATION"],
  [747, 511, 164, 21, "MERCENARY"],
  [728, 599, 301, 16, "DEFEND REMOTE OUTPOST NEAR"],
  [726, 621, 289, 16, "YANG'S PLACE FROM OUTLAWS"],
  [727, 644, 192, 13, "CITIZENS FOR PROSPERITY"],
  [723, 719, 175, 15, "PILOT IN DISTRESS"],
  [723, 743, 193, 12, "CITIZENS FOR PROSPERITY"],
  [717, 818, 141, 16, "EASY PICKINGS"],
  [716, 843, 76, 12, "BIT ZEROS"],
  [709, 921, 326, 16, "SMALL COVALEX SHIPMENT NEEDS"],
  [706, 943, 121, 16, "RECOVERING"],
  [704, 967, 288, 13, "COVALEX INDEPENDENT CONTRACTORS"],
  [692, 1048, 313, 17, "DEFEND REMOTE OUTPOST NEAR"],
  [688, 1071, 331, 17, "CHAWLA'S BEACH FROM OUTLAWS"],
  [684, 1097, 202, 12, "CITIZENS FOR PROSPERITY"],
  [1143, 243, 11, 17, "2"],
  [1148, 335, 11, 16, "2"],
  [1141, 512, 24, 17, "24"],
  [1185, 616, 36, 17, "63k"],
  [1184, 727, 36, 16, "41k"],
  [1109, 827, 108, 17, "Fee:13500"],
  [1174, 939, 37, 17, "35k"],
  [1165, 1067, 37, 18, "63k"],
  // Right-hand pane + bottom nav — must all be ignored.
  [1802, 151, 97, 18, "HISTORY"],
  [1981, 150, 105, 19, "BEACONS"],
  [1957, 693, 213, 16, "Please select a contract."],
  [1291, 1330, 41, 12, "HOME"],
  [1655, 1330, 93, 15, "CONTRACTS"],
  [2323, 1330, 60, 14, "WALLET"],
];

const ocr: OcrResult = {
  w: 3440,
  h: 1440,
  lines: RAW.map(([x, y, w, h, text]) => ({ x, y, w, h, text })),
};

// ── parseAmount ────────────────────────────────────────────────────────────
check("63k -> 63000, rounded", JSON.stringify(parseAmount("63k")) === JSON.stringify({ amount: 63000, kind: "payout", rounded: true }));
check("Fee:13500 is a FEE, exact", JSON.stringify(parseAmount("Fee:13500")) === JSON.stringify({ amount: 13500, kind: "fee", rounded: false }));
check("1.5k -> 1500", parseAmount("1.5k")?.amount === 1500);
check("2m -> 2000000", parseAmount("2m")?.amount === 2_000_000);
check("plain 13500 is exact", JSON.stringify(parseAmount("13500")) === JSON.stringify({ amount: 13500, kind: "payout", rounded: false }));
check("comma grouping", parseAmount("134,500")?.amount === 134500);
// The row-count badges beside a category ("24") sit in the same column as the amounts.
check("row count 24 is not money", parseAmount("24") === null);
check("row count 2 is not money", parseAmount("2") === null);
check("words are not money", parseAmount("MERCENARY") === null);

// ── normalizeTitle ─────────────────────────────────────────────────────────
check(
  "curly and straight apostrophes normalise the same",
  normalizeTitle("Yang’s Place") === normalizeTitle("YANG'S PLACE"),
);
check("placeholder brackets survive", normalizeTitle("Defend near [NearbyLocation]").includes("[NEARBYLOCATION]"));

// ── parseContractList ──────────────────────────────────────────────────────
// The calibrated offers panel, as the app will pass it. Measured off the capture: the
// list sits between the panel's rounded border and the detail pane.
const PANEL = { x: 660, y: 200, w: 580, h: 1000 };
const rows = parseContractList(ocr, PANEL);
check("five contract rows", rows.length === 5, `got ${rows.length}: ${rows.map((r) => r.title).join(" | ")}`);

const byTitle = (frag: string) => rows.find((r) => r.title.includes(frag));

const yang = byTitle("YANG");
check("two-line title is joined", yang?.title === "DEFEND REMOTE OUTPOST NEAR YANG'S PLACE FROM OUTLAWS", yang?.title);
check("giver read", yang?.giver === "CITIZENS FOR PROSPERITY", String(yang?.giver));
check("category is the expanded one", yang?.category === "MERCENARY", String(yang?.category));
check("amount attached to the right row", yang?.amount === 63000, String(yang?.amount));
check("amount marked rounded", yang?.rounded === true);

const pilot = byTitle("PILOT IN DISTRESS");
check("one-line title stays one row", pilot?.title === "PILOT IN DISTRESS", pilot?.title);
check("one-line row gets its own amount", pilot?.amount === 41000, String(pilot?.amount));

// The whole reason this test exists: a cost must never be filed as a reward.
const easy = byTitle("EASY PICKINGS");
check("fee row is kind=fee", easy?.kind === "fee", String(easy?.kind));
check("fee row amount is the fee", easy?.amount === 13500, String(easy?.amount));
check("fee row giver", easy?.giver === "BIT ZEROS", String(easy?.giver));

const covalex = byTitle("COVALEX SHIPMENT");
check("second two-line title joined", covalex?.title === "SMALL COVALEX SHIPMENT NEEDS RECOVERING", covalex?.title);
check("its amount is 35k not the neighbour's", covalex?.amount === 35000, String(covalex?.amount));

const chawla = byTitle("CHAWLA");
check("last row parsed despite perspective drift", chawla?.amount === 63000, String(chawla?.amount));
check("last row giver", chawla?.giver === "CITIZENS FOR PROSPERITY", String(chawla?.giver));

// Nothing from the right-hand pane, the nav bar, or the collapsed categories.
check("no row titled BEACONS/HISTORY/CONTRACTS", !rows.some((r) => /BEACONS|HISTORY|CONTRACTS|WALLET|HOME/.test(r.title)));
check("collapsed categories produce no rows", !rows.some((r) => /^(COLLECTION|DELIVERY|INVESTIGATION)$/.test(r.title)));
check("every row has a title", rows.every((r) => r.title.length > 3));
check("every row got an amount", rows.every((r) => r.amount != null), rows.map((r) => `${r.title.slice(0, 18)}=${r.amount}`).join(", "));

console.log(failures ? `\n${failures} FAILED` : `\nall ${25} checks passed`);
process.exit(failures ? 1 : 0);

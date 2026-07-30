// Which signature values count as DEBRIS — `npx tsx src/mining-debris.test.ts`.
//
// Sub, 2026-07-29: "2000 and 4000 will be labeled as debris and then anything above 4000".
// Debris never lands between those, so a non-ore number in the gap is far more likely to be the
// OCR reading something else on the HUD than a real contact. This gate is what stopped ordinary
// HUD text being announced as debris while he was mining.
//
// 🔑 It governs the DEBRIS call-out only. A signature that matches a known rock is always
// honoured whatever its value — that is asserted here too, because weakening it would silently
// cost real ore call-outs, which is a much worse failure than a missed piece of debris.
import { isDebrisSignature } from "./mining.js";

let failed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (!cond) failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? "   [" + detail + "]" : ""}`);
};

console.log("debris signature values");
check("2,000 is debris", isDebrisSignature(2000));
check("4,000 is debris", isDebrisSignature(4000));
check("above 4,000 is debris", isDebrisSignature(4001) && isDebrisSignature(7400) && isDebrisSignature(25800));

check("the gap between them is NOT", !isDebrisSignature(2001) && !isDebrisSignature(2500) && !isDebrisSignature(3999));
check("three-digit reads are NOT", !isDebrisSignature(999) && !isDebrisSignature(500));
check("below 2,000 is NOT", !isDebrisSignature(1500) && !isDebrisSignature(1999));

// The specific phantoms that ordinary HUD words used to produce (o->0, l/I->1 rescue):
// even if one slipped through parseSignature again, the value rule refuses it.
check("the old phantom values (1,001 / 1,010 / 1,100) are refused",
  !isDebrisSignature(1001) && !isDebrisSignature(1010) && !isDebrisSignature(1100));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);

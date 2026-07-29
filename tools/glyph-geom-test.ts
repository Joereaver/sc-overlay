// Where do we look for the scan glyph? — `npm run test:glyph` (first half; pure maths, no Electron).
//
// The box is derived from the NUMBER's own OCR bbox and nothing else, so it travels with the
// number: head-tracking drift and screen resolution both stop mattering. These assertions use the
// values measured off Sub's 3440×1440 frame (2026-07-24) — pin 15×22px, number 37×13px, gap 11px —
// so a change to the geometry has to keep hitting a pin that we know was really there.
import { glyphSearchBox } from "../src/screen-read.js";

const results: { name: string; pass: boolean; detail: string }[] = [];
const ok = (name: string, pass: boolean, detail: unknown = "") =>
  results.push({ name, pass: !!pass, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });

// A number at (1000,700) sized 37×13 puts the pin at x 963..978 (11px gap, 15px wide) and
// vertically centred on the text.
const line = { text: "3,170", x: 1000, y: 700, w: 37, h: 13 };
const box = glyphSearchBox(line, 3440, 1440);

ok("the box sits entirely LEFT of the number", box.x + box.w <= line.x, box);
ok("...covering the measured pin's x range (963..978)", box.x <= 963 && box.x + box.w >= 978, box);
ok("...and its 22px height, centred on the text", box.y <= 695 && box.y + box.h >= 717, box);

// Resolution independence: the same layout at half scale must still frame the pin.
const half = { text: "3,170", x: 500, y: 350, w: 19, h: 7 };
const hbox = glyphSearchBox(half, 1720, 720);
ok("half-resolution: still left of the number", hbox.x + hbox.w <= half.x, hbox);
ok("half-resolution: still wide enough for a pin at ~5px gap", hbox.w >= 15, hbox);

// Edge cases that would otherwise sample outside the frame.
const edge = glyphSearchBox({ ...line, x: 5 }, 3440, 1440);
ok("a number at the left edge clamps into the frame", edge.x >= 0 && edge.w >= 1, edge);
const top = glyphSearchBox({ ...line, y: 0 }, 3440, 1440);
ok("a number at the top edge clamps into the frame", top.y >= 0 && top.h >= 1, top);
const zero = glyphSearchBox({ ...line, h: 0 }, 3440, 1440);
ok("a zero-height bbox does not collapse the box", zero.w > 0 && zero.h > 0, zero);

for (const r of results) console.log(`  ${r.pass ? "ok  " : "FAIL"} ${r.name}${r.detail ? "   [" + r.detail + "]" : ""}`);
const failed = results.filter((r) => !r.pass).length;
console.log(`  ${results.length - failed}/${results.length} passed` + (failed ? `  <<< ${failed} FAILED` : ""));
process.exit(failed ? 1 : 0);

// Scan-glyph detection tests — `npm run test:glyph` (needs Electron for nativeImage only).
//
// The mining scanner used to call out any comma-grouped number the OCR found near screen centre,
// which is how "Debris" ended up in the player's ear mid-flight. A real signature is drawn beside
// a map-pin glyph; Windows OCR is text-only and can't see it, so the check is done on pixels.
//
// These build synthetic frames from the values MEASURED off Sub's 3440×1440 frame (2026-07-24):
// pin 15×22px, number 37×13px, gap 11px, pin mean RGB (190,200,113), HUD yellow B≈25–43. That
// means the geometry and the colour band can both be tested without a live game, and a real frame
// later only needs to confirm the thresholds — not discover them.
const { app, nativeImage } = require("electron");
const path = require("path");

const { findScanGlyph, GLYPH } = require(path.join(__dirname, "..", "electron", "capture.cjs"));

const results = [];
const ok = (name, pass, detail = "") => results.push({ name, pass: !!pass, detail: String(detail) });

/** Build a BGRA bitmap of `w`×`h`, fill it, then paint `rects` of [colour] onto it. */
function frame(w, h, bg, rects = []) {
  const buf = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = bg[2]; buf[i * 4 + 1] = bg[1]; buf[i * 4 + 2] = bg[0]; buf[i * 4 + 3] = 255;
  }
  for (const { x, y, w: rw, h: rh, rgb } of rects) {
    for (let yy = y; yy < y + rh; yy++) {
      for (let xx = x; xx < x + rw; xx++) {
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const i = (yy * w + xx) * 4;
        buf[i] = rgb[2]; buf[i + 1] = rgb[1]; buf[i + 2] = rgb[0]; buf[i + 3] = 255;
      }
    }
  }
  return nativeImage.createFromBitmap(buf, { width: w, height: h });
}

const SPACE = [8, 10, 14];        // dark space behind the HUD
const PIN = [190, 200, 113];      // measured pin mean
const HUD_YELLOW = [200, 190, 35];// the SCANNING label etc. — B far too low
const HUD_CYAN = [69, 208, 224];  // the overlay's own accent
const WHITE = [255, 255, 255];

app.whenReady().then(() => {
  // ── colour: what must and must not read as the glyph ─────────────────────────────────────
  const at = (rgb) => {
    const img = frame(80, 60, SPACE, [{ x: 20, y: 15, w: 15, h: 22, rgb }]);
    return findScanGlyph(img, { x: 10, y: 5, w: 40, h: 40 });
  };
  ok("the measured pin is FOUND", at(PIN).seen, JSON.stringify(at(PIN)));
  ok("HUD yellow is not (blue too low)", !at(HUD_YELLOW).seen, JSON.stringify(at(HUD_YELLOW)));
  ok("the overlay's own cyan is not (green far above red)", !at(HUD_CYAN).seen, JSON.stringify(at(HUD_CYAN)));
  ok("white is not (no yellow-green gap at all)", !at(WHITE).seen, JSON.stringify(at(WHITE)));
  ok("empty space is not", !findScanGlyph(frame(80, 60, SPACE), { x: 10, y: 5, w: 40, h: 40 }).seen);

  // Translucency: the pill blends with whatever is behind it, so test the pin mixed 50/50 with a
  // bright rock and with dark space — the case the measurements warned had never been validated.
  const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
  ok("still found blended 50% into dark space", at(mix(PIN, SPACE, 0.5)).seen, JSON.stringify(at(mix(PIN, SPACE, 0.5))));
  const ROCK = [150, 140, 120];
  ok("still found blended 50% into a lit rock", at(mix(PIN, ROCK, 0.5)).seen, JSON.stringify(at(mix(PIN, ROCK, 0.5))));

  // ── a whole-frame rehearsal: number, pin, and a SCANNING label that must not fool it ──────
  const scene = frame(400, 200, SPACE, [
    { x: 120, y: 92, w: 15, h: 22, rgb: PIN },        // the pin
    { x: 146, y: 96, w: 37, h: 13, rgb: WHITE },      // the number itself
    { x: 40, y: 40, w: 90, h: 16, rgb: HUD_YELLOW },  // "SCANNING"
  ]);
  // The box glyphSearchBox() produces for a 37×13 number at x=146 (asserted separately in
  // glyph-geom-test.ts): 34 wide, 29 tall, ending just left of the number.
  const searchBox = { x: 110, y: 88, w: 34, h: 29 };
  ok("a full scene reads as a real scan", findScanGlyph(scene, searchBox).seen);
  const noPin = frame(400, 200, SPACE, [
    { x: 146, y: 96, w: 37, h: 13, rgb: WHITE },      // a bare number, no pin beside it
    { x: 40, y: 40, w: 90, h: 16, rgb: HUD_YELLOW },
  ]);
  ok("the same number with NO pin does not", !findScanGlyph(noPin, searchBox).seen,
     JSON.stringify(findScanGlyph(noPin, searchBox)));

  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`  ${r.pass ? "ok  " : "FAIL"} ${r.name}${r.detail ? "   [" + r.detail + "]" : ""}`);
  console.log(`\n  ${results.length - failed.length}/${results.length} passed` + (failed.length ? `  <<< ${failed.length} FAILED` : ""));
  app.exit(failed.length ? 1 : 0);
});

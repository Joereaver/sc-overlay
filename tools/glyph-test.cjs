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
  // 🔑 THE CONTRACT CHANGED. There is no "pin colour" any more: the pin is drawn in the SHIP'S
  // HUD colour, which changes with the ship, so the old absolute yellow-green band could only
  // ever confirm for the one ship it was measured on — and every other HUD silently made pure
  // debris un-announceable (debris has no rock-table match, so the glyph is its only evidence).
  // The invariant now is RELATIVE: the pin matches the colour of the NUMBER beside it, because
  // both are the same HUD layer. So these cases sweep several HUD colours rather than one.
  const searchBox = { x: 110, y: 88, w: 34, h: 29 };
  const NUM = { x: 146, y: 96, w: 37, h: 13 };  // the number's own bbox, the colour reference
  const PIN_AT = { x: 120, y: 92, w: 15, h: 22 };
  /** A scene with a number in `numRgb` and, optionally, a pin in `pinRgb` beside it. */
  const scene = (numRgb, pinRgb, extra = []) => frame(400, 200, SPACE, [
    ...(pinRgb ? [{ ...PIN_AT, rgb: pinRgb }] : []),
    { ...NUM, rgb: numRgb },
    ...extra,
  ]);
  const look = (numRgb, pinRgb, extra) => findScanGlyph(scene(numRgb, pinRgb, extra), searchBox, NUM);

  // Every one of these is a plausible ship HUD. All must confirm — that is the entire fix.
  for (const [label, hud] of [
    ["the measured yellow-green HUD", PIN],
    ["a cyan HUD", HUD_CYAN],
    ["a white HUD", WHITE],
    ["an amber HUD", [235, 170, 40]],
    ["a red HUD", [220, 70, 60]],
    ["a green HUD", [80, 220, 110]],
  ]) {
    const r = look(hud, hud);
    ok(`${label}: pin matching its number is FOUND`, r.seen, JSON.stringify({ f: r.fraction, ref: r.ref && r.ref.mean }));
  }

  // The discriminator is no longer hue-in-the-abstract but hue RELATIVE to the number.
  ok("a pin in a DIFFERENT colour from the number is not",
     !look(HUD_CYAN, [235, 170, 40]).seen, JSON.stringify(look(HUD_CYAN, [235, 170, 40])));
  ok("a bare number with no pin is not", !look(WHITE, null).seen, JSON.stringify(look(WHITE, null)));
  ok("empty space is not", !findScanGlyph(frame(400, 200, SPACE), searchBox, NUM).seen);
  // A HUD label elsewhere on screen must not leak in — the search box is anchored on the number.
  ok("a SCANNING label outside the box does not count",
     !look(WHITE, null, [{ x: 40, y: 40, w: 90, h: 16, rgb: WHITE }]).seen);

  // Translucency: the pill blends with whatever is behind it. Brightness-normalised hue is what
  // makes this survive — a dimmed pin keeps its hue even as its luminance falls.
  const mix = (a, b, t) => a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
  ok("still found blended 50% into dark space", look(PIN, mix(PIN, SPACE, 0.5)).seen,
     JSON.stringify(look(PIN, mix(PIN, SPACE, 0.5))));
  const ROCK = [150, 140, 120];
  ok("still found blended 50% into a lit rock", look(PIN, mix(PIN, ROCK, 0.5)).seen,
     JSON.stringify(look(PIN, mix(PIN, ROCK, 0.5))));

  // Without a text rect there is nothing to calibrate against, and it must REFUSE rather than
  // fall back to a guessed colour — a wrong absolute colour is the bug being fixed.
  const noRef = findScanGlyph(scene(PIN, PIN), searchBox, null);
  ok("no text rect -> refuses, and says why", !noRef.seen && /calibrate/.test(noRef.why), noRef.why);

  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log(`  ${r.pass ? "ok  " : "FAIL"} ${r.name}${r.detail ? "   [" + r.detail + "]" : ""}`);
  console.log(`\n  ${results.length - failed.length}/${results.length} passed` + (failed.length ? `  <<< ${failed.length} FAILED` : ""));
  app.exit(failed.length ? 1 : 0);
});

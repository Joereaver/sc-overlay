/**
 * Bun-compile the overlay server (no window) into a standalone .exe + its runtime
 * assets, for the Electron app to spawn in production (no Node/tsx on the user's
 * machine). electron-builder ships build/server/ as an extraResource → resources/server.
 *
 *   npm run build:server  ->  build/server/{sc-overlay-server.exe, overlay/, data/}
 */
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { basename } from "node:path";

const out = "build/server";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

console.log("Compiling overlay server (bun) …");
execSync(`bun build src/overlay-server.ts --compile --outfile ${out}/sc-overlay-server.exe`, {
  stdio: "inherit",
});

// Per-changelist datasets stay in the repo for dev, but only `latest` ships: the newest
// per-changelist pair is byte-identical to the .latest files (checked 0.1.41 — cmp says so),
// and old generations (4.8.x) are unreachable on live servers. A player on an unbundled
// changelist resolves exact → remote fetch (subliminal.gg/sc) → latest, same as today.
// Shipping all generations cost 25.5 MB of the 32 MB data dir.
const OLD_DATASET = /^blueprint(?:s|-detail)\.\d+\.json$/;
for (const dir of ["overlay", "data"]) {
  // Never ship overlay/config.json — it's the developer's personal config (erkul
  // URLs + sync token). The server seeds from DEFAULTS and persists to %APPDATA%.
  cpSync(dir, `${out}/${dir}`, {
    recursive: true,
    filter: (src) => basename(src) !== "config.json" && !OLD_DATASET.test(basename(src)),
  });
  console.log(`copied ${dir}/ -> ${out}/${dir}/`);
}
console.log("server bundle ->", out);

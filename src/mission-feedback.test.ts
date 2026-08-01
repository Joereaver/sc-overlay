/**
 * Self-check for the crowdsourced mission-feedback store.
 * Run with:  npx tsx src/mission-feedback.test.ts
 * Exits non-zero on any failed case.
 *
 * Runs against a throwaway directory, NOT %APPDATA% — this must never touch a real player's
 * answers, and it must not need the sidecar (which in practice is the live app someone is
 * playing on).
 */
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeAnswer, MissionFeedbackStore } from "./mission-feedback.js";

let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`);
}

// --- validation ------------------------------------------------------------------------------
check("no contract key -> rejected", sanitizeAnswer({ difficulty: 3 }), null);
check("key but no answers -> rejected (nothing worth storing)", sanitizeAnswer({ contractKey: "HH_x" }), null);
check("difficulty 0 out of range", sanitizeAnswer({ contractKey: "HH_x", difficulty: 0 }), null);
check("difficulty 6 out of range", sanitizeAnswer({ contractKey: "HH_x", difficulty: 6 }), null);
check("difficulty 2.5 rejected (not an integer)", sanitizeAnswer({ contractKey: "HH_x", difficulty: 2.5 }), null);
check("bogus combat value dropped",
  sanitizeAnswer({ contractKey: "HH_x", combat: "banana", difficulty: 3 })?.combat, null);
check("solo must be a real boolean, not truthy",
  sanitizeAnswer({ contractKey: "HH_x", solo: "yes", difficulty: 3 })?.solo, null);
check("valid combat kept", sanitizeAnswer({ contractKey: "HH_x", combat: "fps" })?.combat, "fps");
check("solo false is an ANSWER, not an absence",
  sanitizeAnswer({ contractKey: "HH_x", solo: false })?.solo, false);
check("whitespace key trimmed", sanitizeAnswer({ contractKey: "  HH_x  ", difficulty: 1 })?.contractKey, "HH_x");

// --- store round-trip ------------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "scfb-"));
try {
  const store = new MissionFeedbackStore(dir);
  check("starts empty", store.count(), 0);
  check("unknown key reads null", store.get("nope"), null);
  check("null key reads null", store.get(null), null);

  store.record({ contractKey: "HH_Pyro_RegionC_DerelictOutpost_EliminateAll", combat: "fps", difficulty: 3, solo: true });
  check("one answer stored", store.count(), 1);
  check("reads back", store.get("HH_Pyro_RegionC_DerelictOutpost_EliminateAll")?.combat, "fps");
  check("marked pending for upload", store.pending().length, 1);

  // Last write wins — people re-run a mission and revise. A second row for the same contract
  // would double-count that player in any consensus built on top of this.
  store.record({ contractKey: "HH_Pyro_RegionC_DerelictOutpost_EliminateAll", combat: "mixed", difficulty: 5, solo: false });
  check("revision replaces, does not append", store.count(), 1);
  check("revision won", store.get("HH_Pyro_RegionC_DerelictOutpost_EliminateAll")?.combat, "mixed");
  check("revised difficulty", store.get("HH_Pyro_RegionC_DerelictOutpost_EliminateAll")?.difficulty, 5);

  store.record({ contractKey: "Covalex_Hauling_1", difficulty: 1 });
  check("second contract is its own row", store.count(), 2);
  check("rejected submission is not stored", store.record({ contractKey: "junk" }), null);
  check("still two rows after a rejection", store.count(), 2);

  check("file written", existsSync(join(dir, "mission-feedback.json")), true);
  const onDisk = JSON.parse(readFileSync(join(dir, "mission-feedback.json"), "utf8"));
  check("file holds both rows", onDisk.length, 2);

  // Survives a restart — the queue is the file, not the process.
  const reopened = new MissionFeedbackStore(dir);
  check("reloads from disk", reopened.count(), 2);
  check("reloads the revised value", reopened.get("HH_Pyro_RegionC_DerelictOutpost_EliminateAll")?.difficulty, 5);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? "ALL PASS" : failed + " FAILED"}`);
process.exit(failed === 0 ? 0 : 1);

import assert from "node:assert/strict";
import { parseMissionEvent } from "./missions-parser.js";
import type { LogEvent } from "./parser.js";

function event(message: string): LogEvent {
  return { eventTag: "SHUDEvent_OnNotification", timestamp: "2026-07-22T00:00:00.000Z", message } as LogEvent;
}

const acceptMessage = 'Added notification "Contract Accepted: <EM4>[N Rep] [BP]*</EM4>Jorrit Dossier: Updated Security Data: " [9] to queue. MissionId: [11111111-2222-3333-4444-555555555555]';
const completeMessage = 'Added notification "Contract Complete: <EM4>[BP]*</EM4>Rescue Run: Final Checkpoint: " [9] to queue. MissionId: [11111111-2222-3333-4444-555555555555]';

const accept = parseMissionEvent(event(acceptMessage));
assert(accept?.kind === "accept", "accept event should parse");
assert.equal(accept?.title, "Jorrit Dossier: Updated Security Data", "accept title should strip markup and badges");

const complete = parseMissionEvent(event(completeMessage));
assert(complete?.kind === "contractComplete", "complete event should parse");
assert.equal(complete?.title, "Rescue Run: Final Checkpoint", "complete title should strip markup and badges");

// A REAL line from a user's shared log (johnrgoudy, 0.1.36, 2026-08-03), copied verbatim.
// The fixtures above use "[N Rep]" — the PLACEHOLDER form — and the old stripper anchored on
// that literal, so the live game's substituted number survived: the title keyed as
// "SHIP IN DISTRESS 300 REP" instead of "SHIP IN DISTRESS", missed the rep-title index, and
// accrueFromTitle silently skipped it. He ground Battaglia contracts with his standing pinned
// at zero. Note the DOUBLE SPACE after the colon and the title-before-markup order — both
// differ from the fixtures above, which is why this is kept verbatim rather than tidied.
const realBattagliaAccept = 'Added notification "Contract Accepted:  Ship In Distress <EM4>[300 Rep] [BP]*</EM4>: " [4] to queue. New queue size: 1, MissionId: [a6d6b4e1-07cb-4076-9a82-0bcd1b8b373e], ObjectiveId: [] [Team_CoreGameplayFeatures][Missions][Comms]';
const realAccept = parseMissionEvent(event(realBattagliaAccept));
assert(realAccept?.kind === "accept", "real Battaglia accept should parse");
assert.equal(realAccept?.title, "Ship In Distress",
  "a numeric rep badge must be stripped — it is what kept Battaglia standing at zero");

// The badge is a bracket containing Rep/BP as a word, whatever precedes it. Pinning the shapes
// rather than one sample, since the game has already changed this text once.
for (const badge of ["[300 Rep]", "[Rep]", "[N Rep]", "[1,200 Rep]", "[BP]", "[BP]*"]) {
  const line = `Added notification "Contract Accepted: Ship In Distress <EM4>${badge}</EM4>: " [4] to queue. MissionId: [11111111-2222-3333-4444-555555555555]`;
  const ev = parseMissionEvent(event(line));
  assert(ev?.kind === "accept", `badge ${badge} should still parse as an accept`);
  assert.equal(ev.title, "Ship In Distress", `badge ${badge} should be stripped`);
}

console.log("missions-parser tests passed");

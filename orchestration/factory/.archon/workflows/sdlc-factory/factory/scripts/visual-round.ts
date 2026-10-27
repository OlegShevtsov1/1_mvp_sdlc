import { emit } from "./_lib/io.ts";
import { FILES, readSaved, visualRound } from "./_lib/visual.ts";

// Binding: visual, gate (the visual-cycle loop's output, empty when it was skipped) and delivery.
// The files in ARTIFACTS_DIR win over the loop's output: until_bash saved the answer (PILOT-217),
// and visual-shots saved the round's readiness, which no node outside the loop can reference.
const dir = process.env.ARTIFACTS_DIR ?? ".";
const decision = readSaved(dir, FILES.decision);
emit(
  visualRound({
    visual: process.env.INPUTS_VISUAL ?? "",
    gate: process.env.INPUTS_GATE ?? "",
    saved: decision === null ? null : { decision, text: readSaved(dir, FILES.text) ?? "" },
    shots: readSaved(dir, FILES.shots),
    delivery: process.env.INPUTS_DELIVERY ?? "",
  }),
);

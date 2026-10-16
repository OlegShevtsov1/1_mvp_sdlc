import { emit } from "./_lib/io.ts";
import { roundVerdict } from "./_lib/gate.ts";

// Bound by the workflow as `with: { gate: "$<loop>.output" }` (whole output).
const raw = process.env.INPUTS_GATE ?? "";
emit(roundVerdict(raw));

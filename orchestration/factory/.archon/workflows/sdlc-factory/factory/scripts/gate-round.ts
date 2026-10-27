import { existsSync, readFileSync } from "node:fs";
import { emit } from "./_lib/io.ts";
import { roundVerdict } from "./_lib/gate.ts";

// Bound by the workflow as `with: { gate: "$<loop>.output", decision_file: … }`.
// The file is written by the loop's until_bash; it wins when present because
// Archon v0.12.1 hands a resumed loop the wrong node's output (PILOT-217).
const raw = process.env.INPUTS_GATE ?? "";
const file = process.env.INPUTS_DECISION_FILE ?? "";
const saved = file && existsSync(file) ? readFileSync(file, "utf8").trim() : "";
emit(roundVerdict(raw, saved));

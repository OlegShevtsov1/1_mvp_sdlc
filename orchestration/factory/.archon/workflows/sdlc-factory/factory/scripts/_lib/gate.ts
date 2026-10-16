import { parseJsonObject } from "./io.ts";

export interface GateOutput {
  decision: string;
  text: string;
}

// A real gate with authored `decisions:` outputs {decision, text}.
// The dry-run simulator auto-approves with the plain string "approved".
export function parseGate(raw: string): GateOutput {
  const doc = parseJsonObject(raw);
  if (doc !== null) {
    return { decision: String(doc.decision ?? ""), text: String(doc.text ?? "") };
  }
  const trimmed = raw.trim();
  if (trimmed === "approved") return { decision: "approve", text: "" };
  return { decision: trimmed, text: "" };
}

export interface RoundVerdict {
  proceed: boolean;
  decision: string;
  stop_reason: string;
}

export function roundVerdict(raw: string): RoundVerdict {
  const gate = parseGate(raw);
  const proceed = gate.decision === "approve";
  return {
    proceed,
    decision: gate.decision,
    stop_reason: proceed ? "" : `operator chose ${gate.decision || "nothing"}: ${gate.text}`.trimEnd(),
  };
}

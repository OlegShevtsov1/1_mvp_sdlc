import type { Decision } from "./act.ts";
import type { Policy } from "./main.ts";
import type { Pause, RunView } from "./runs.ts";

export type GateRules = {
  "plan-gate"?: { approve_text: string; open_question_prefix: string };
  "install-gate"?: { max_retries: number };
};

const OPERATOR = "потрібне рішення оператора.";

const isText = (v: unknown): v is string => typeof v === "string" && v !== "";

const SHAPES: { [K in keyof GateRules]-?: (r: Record<string, unknown>) => boolean } = {
  "plan-gate": (r) => isText(r.approve_text) && isText(r.open_question_prefix),
  "install-gate": (r) => Number.isInteger(r.max_retries) && (r.max_retries as number) >= 0,
};

const isGate = (id: unknown): id is keyof GateRules => typeof id === "string" && Object.hasOwn(SHAPES, id);

// Entries with other ids belong to other rule families and are left to their readers.
export function gateRules(rules: unknown[]): GateRules {
  const gates: Record<string, unknown> = {};
  for (const rule of rules) {
    if (!rule || typeof rule !== "object") continue;
    const r = rule as Record<string, unknown>;
    if (!isGate(r.id)) continue;
    if (Object.hasOwn(gates, r.id)) throw new Error(`policy: rule ${r.id} is defined twice`);
    if (!SHAPES[r.id](r)) throw new Error(`policy: rule ${r.id} is malformed`);
    gates[r.id] = r;
  }
  return gates as GateRules;
}

export function decide(run: RunView, policy: Policy, ctx: { activeFactoryRuns: string[] }): Decision {
  const pause = run.pause;
  if (!pause) return { action: "none", rule: "no-pause", text: "" };
  const gates = gateRules(policy.rules);
  if (pause.kind === "plan-gate" && gates["plan-gate"]) return planGate(pause, gates["plan-gate"]);
  if (pause.kind === "install-gate" && gates["install-gate"]) return installGate(pause, gates["install-gate"], ctx);
  if (pause.kind === "post-merge-gate") return postMergeGate(pause);
  return {
    action: "escalate",
    rule: "default-escalate",
    text: `Політика не має правила для паузи ${pause.kind} (${pause.node}) — ${OPERATOR}`,
  };
}

const escalate = (rule: string, text: string): Decision => ({ action: "escalate", rule, text });

function planGate(pause: Pause, rule: NonNullable<GateRules["plan-gate"]>): Decision {
  const id = "plan-gate";
  if (!pause.plan) return escalate(id, `План не прочитано (немає виходу вузла plan) — ${OPERATOR}`);
  if (pause.plan.ready !== true) return escalate(id, `План не готовий (Ready to build: false) — ${OPERATOR}`);
  const blocking = pause.plan.openQuestions.find((q) => !q.trimStart().startsWith(rule.open_question_prefix));
  if (blocking !== undefined) {
    return escalate(id, `План має блокуюче відкрите питання: ${blocking.slice(0, 200)} — ${OPERATOR}`);
  }
  return { action: "approve", rule: id, text: rule.approve_text };
}

// install-verify renders each blocker as `<id8> <workflow> <path>`, joined with `; `.
function installGate(
  pause: Pause, rule: NonNullable<GateRules["install-gate"]>, ctx: { activeFactoryRuns: string[] },
): Decision {
  const id = "install-gate";
  const line = pause.text.split("\n").find((l) => l.startsWith("Блокують: "))?.slice("Блокують: ".length) ?? "";
  const blockers = line.split("; ").filter(Boolean);
  const activeFactory = (b: string) => {
    const id8 = b.match(/^([0-9a-f]{8}) factory /)?.[1];
    return id8 !== undefined && ctx.activeFactoryRuns.some((r) => r.startsWith(id8));
  };
  if (blockers.length === 0 || !blockers.every(activeFactory)) {
    return escalate(id, `Встановлення блокує не активний factory (${line}) — ${OPERATOR}`);
  }
  if (pause.iteration - 1 >= rule.max_retries) {
    return escalate(id,
      `Встановлення чекає вже після ${rule.max_retries} retry (≈1 год), factory досі активний: ${line} — ${OPERATOR}`);
  }
  return {
    action: "retry",
    rule: id,
    text: `Retry by sdlc-autopilot policy install-gate (attempt ${pause.iteration} of ${rule.max_retries}).`,
  };
}

// A post-merge step that needs a person always gets one: no list of destructive words can be complete, so no
// 🔒 step is approved by marker, and checkout and mismatch steps are the operator's too.
function postMergeGate(pause: Pause): Decision {
  const field = (name: string) =>
    pause.text.split("\n").find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2).trim() ?? "";
  const step = field("Крок").slice(0, 200) || pause.node;
  return escalate("post-merge-gate",
    `Крок post-merge «${step}» (тип ${field("Тип") || "невідомий"}) схвалює лише оператор — ${OPERATOR}`);
}

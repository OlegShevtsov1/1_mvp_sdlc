import { parseJsonObject } from "./io.ts";
import { type CiCheck, ciRefusal } from "./merge-decision.ts";
import { appendToNewestBody, newestBody } from "./pr-body.ts";
import {
  cardLabel,
  createFollowUpCards,
  type CardResult,
  DEFAULT_LISTS,
  type Lists,
  listNames,
  parseCardRef,
  readCreds,
  runIdFrom,
} from "./trello.ts";

// PILOT-300 (decisions 93, 99, 100): from this round on, a delivery whose only
// open blockers re-raise earlier findings on narrower cases is ready, with a
// follow-up card per such finding, instead of another replan or the round cap.
export const FIRST_FOLLOW_UP_ROUND = 3;
const CONSIDERED = ["replan", "round_cap"];

// The bundled Archon text this module reads. scripts/ci/archon-check.sh fails
// when the pinned binary stops embedding one of them; the binary holds the
// bundled scripts as template text, so their `${` is escaped.
export const REVIEW_MARKER = "<!-- archon-review-report -->";
const LEFT_OPEN_HEADER = "Left open, so the pull request does not close its issue";
export const BUNDLED_LITERALS = [
  // deliver/scripts/round.ts and outcome.ts render "Not ready: Round <N>: <reason>".
  "Round \\${round}: ",
  "'Not ready'}: \\${rounds.summary}",
  LEFT_OPEN_HEADER,
  REVIEW_MARKER,
  "Reviewed commit: ",
  "$ARTIFACTS_DIR/review/findings.json",
  "$ARTIFACTS_DIR/review/report-round-N.md",
  "{id, severity, sources, claim, status, round}",
];

const ROUND = /^Not ready: Round (\d+): /;
export const REVIEWED_COMMIT = /^Reviewed commit: `([0-9a-f]{7,64})`$/m;

export function roundOf(summary: string): number | null {
  const m = ROUND.exec(summary);
  return m ? Number(m[1]) : null;
}

// The contract items the latest review left open: the bullets after the header,
// up to the first blank line. An item that spans lines stays one item.
export function leftOpenItems(summary: string): string[] {
  const lines = summary.split("\n");
  const at = lines.indexOf(`${LEFT_OPEN_HEADER}:`);
  if (at < 0) return [];
  const items: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === "") break;
    if (line.startsWith("- ")) items.push(line.slice(2));
    else if (items.length > 0) items[items.length - 1] += `\n${line}`;
  }
  return items;
}

// One record of the bundled review's findings.json.
export interface Finding {
  id: string;
  severity: string;
  sources: string[];
  claim: string;
  status: string;
  round: number;
}

// The review-state node's facts. `round` is the deliver round; review and
// rereview each run a review round, so a finding's `round` counts in
// `review_round`, the latest one, not in `round`.
export interface ReviewState {
  pr_url: string;
  round: number;
  review_round: number;
  read: boolean;
  head: string;
  is_draft: boolean;
  checks: CiCheck[];
  checks_read: boolean;
  review_url: string;
  review_commit: string;
  findings_read: boolean;
  findings: Finding[];
}

export type Verdict = "narrower" | "unfixed" | "new";

// The followup-judge node's output.
export interface Judgement {
  id: string;
  verdict: Verdict;
  earlier_id: string;
  why: string;
}

export interface LeftOpenJudgement {
  item: string;
  finding_ids: string[];
  only_followups: boolean;
}

export interface Judge {
  findings: Judgement[];
  left_open: LeftOpenJudgement[];
}

const isString = (v: unknown): v is string => typeof v === "string";
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export function parseFindings(doc: unknown): Finding[] | null {
  if (!Array.isArray(doc)) return null;
  const findings: Finding[] = [];
  for (const f of doc) {
    if (!isObject(f) || !isString(f.id) || !isString(f.severity) || !isStrings(f.sources) || !isString(f.claim)
      || !isString(f.status) || typeof f.round !== "number") return null;
    findings.push({ id: f.id, severity: f.severity, sources: f.sources, claim: f.claim, status: f.status, round: f.round });
  }
  return findings;
}

function parseChecks(doc: unknown): CiCheck[] | null {
  if (!Array.isArray(doc) || !doc.every((c) => isObject(c) && isString(c.name) && isString(c.bucket))) return null;
  return doc.map((c) => ({ name: c.name, bucket: c.bucket }));
}

// Null for a skipped producer's empty binding or an output of another shape.
export function parseState(raw: string): ReviewState | null {
  const d = parseJsonObject(raw);
  if (d === null) return null;
  const checks = parseChecks(d.checks);
  const findings = parseFindings(d.findings);
  if (checks === null || findings === null || !isString(d.pr_url) || typeof d.round !== "number"
    || typeof d.review_round !== "number"
    || typeof d.read !== "boolean" || !isString(d.head) || typeof d.is_draft !== "boolean"
    || typeof d.checks_read !== "boolean" || !isString(d.review_url) || !isString(d.review_commit)
    || typeof d.findings_read !== "boolean") return null;
  return {
    pr_url: d.pr_url, round: d.round, review_round: d.review_round, read: d.read, head: d.head, is_draft: d.is_draft, checks,
    checks_read: d.checks_read, review_url: d.review_url, review_commit: d.review_commit,
    findings_read: d.findings_read, findings,
  };
}

const VERDICTS: readonly string[] = ["narrower", "unfixed", "new"] satisfies Verdict[];

export function parseJudge(raw: string): Judge | null {
  const d = parseJsonObject(raw);
  if (d === null || !Array.isArray(d.findings) || !Array.isArray(d.left_open)) return null;
  const findings: Judgement[] = [];
  for (const j of d.findings) {
    if (!isObject(j) || !isString(j.id) || !isString(j.verdict) || !VERDICTS.includes(j.verdict)
      || !isString(j.earlier_id) || !isString(j.why)) return null;
    findings.push({ id: j.id, verdict: j.verdict as Verdict, earlier_id: j.earlier_id, why: j.why });
  }
  const left_open: LeftOpenJudgement[] = [];
  for (const l of d.left_open) {
    if (!isObject(l) || !isString(l.item) || !isStrings(l.finding_ids) || typeof l.only_followups !== "boolean") return null;
    left_open.push({ item: l.item, finding_ids: l.finding_ids, only_followups: l.only_followups });
  }
  return { findings, left_open };
}

export interface FollowUp {
  finding: Finding;
  judgement: Judgement;
}

export type Decision =
  | { kind: "pass" }
  | { kind: "declined"; reason: string }
  | { kind: "follow"; round: number; followups: FollowUp[]; state: ReviewState };

function ciReason(state: ReviewState): string | null {
  if (!state.checks_read) return "the pull request's CI checks could not be read";
  const red = ciRefusal(state.checks);
  if (red !== null) return red;
  const pending = state.checks.find((c) => c.bucket === "pending");
  if (pending) return `CI check ${pending.name} is still pending on the pull request head`;
  if (!state.checks.some((c) => c.bucket === "pass")) return "no CI check passed on the pull request head";
  return null;
}

// The AI judge says which blockers narrow an earlier finding; this checks every
// claim it can against the record, and anything in doubt keeps today's behaviour.
export function decideFollowUp(i: { delivery: Record<string, unknown>; state: ReviewState | null; judge: Judge | null }): Decision {
  const reason = String(i.delivery.reason ?? "");
  if (!CONSIDERED.includes(reason)) return { kind: "pass" };
  const declined = (why: string): Decision => ({ kind: "declined", reason: why });
  const summary = String(i.delivery.summary ?? "");

  const round = roundOf(summary);
  if (round === null) return declined("the delivery summary names no round");
  if (round < FIRST_FOLLOW_UP_ROUND) return declined(`the delivery ended at round ${round}, before round ${FIRST_FOLLOW_UP_ROUND}`);
  const { state, judge } = i;
  if (state === null || !state.read) return declined("the pull request and its review could not be read");
  if (!state.findings_read) return declined("the review's findings.json could not be read");
  if (state.review_round < 1) return declined("the review's round could not be read");
  if (judge === null) return declined("the follow-up judge did not run");

  const byId = new Map(state.findings.map((f) => [f.id, f]));
  const open = state.findings.filter((f) => f.severity === "blocking" && f.status === "open");
  if (open.length === 0) return declined("no blocking finding is open");

  const followups: FollowUp[] = [];
  for (const finding of open) {
    const judgement = judge.findings.find((j) => j.id === finding.id);
    if (judgement === undefined) return declined(`the judge did not judge ${finding.id}`);
    if (judgement.verdict !== "narrower") {
      return declined(`the judge found ${finding.id} ${judgement.verdict}, not a narrower case of an earlier finding`);
    }
    const earlier = byId.get(judgement.earlier_id);
    if (earlier === undefined) return declined(`${finding.id}'s earlier finding ${judgement.earlier_id} is not in findings.json`);
    // A carried id was first raised in an earlier round; a new id narrows one raised before it.
    const before = earlier.id === finding.id ? finding.round < state.review_round : earlier.round < finding.round;
    if (!before) return declined(`${finding.id}'s earlier finding ${earlier.id} was not raised before ${finding.id}`);
    if (finding.sources.includes("contract") && finding.round === state.review_round) {
      return declined(`${finding.id} is a contract finding raised in review round ${state.review_round}`);
    }
    followups.push({ finding, judgement });
  }

  // Decision 100, Q1 (b): an item left open only on the evidence of followed-up findings counts as met.
  const ids = new Set(open.map((f) => f.id));
  for (const item of leftOpenItems(summary)) {
    const entry = judge.left_open.find((l) => l.item.trim() === item.trim());
    const covered = entry !== undefined && entry.only_followups && entry.finding_ids.length > 0
      && entry.finding_ids.every((id) => ids.has(id));
    if (!covered) return declined(`the open item "${item}" is not left open only by followed-up findings`);
  }

  const ci = ciReason(state);
  if (ci !== null) return declined(ci);
  if (state.review_commit !== state.head) {
    return declined(`the review comment judged ${state.review_commit || "no commit"}, not the pull request head ${state.head}`);
  }
  return { kind: "follow", round, followups, state };
}

export interface FollowUpInput {
  delivery: string;
  state: string;
  judge: string;
  task: string;
  request: string;
  artifactsDir: string;
  envFile: string;
}

export interface FollowUpDeps {
  fetch: typeof fetch;
  gh: (args: string[]) => { ok: boolean; err: string };
  // Returns the parsed profile, or undefined when there is none.
  readProfile: () => Promise<unknown>;
}

// The deliver report, which every later node reads from here instead.
export type FollowUpReport = Record<string, unknown> & {
  ready: boolean;
  reason: string;
  pr_url: string;
  summary: string;
  followed_up: boolean;
  cards: CardResult[];
  warning: string;
};

const TITLE_LIMIT = 100;
const firstLine = (text: string) => text.split("\n")[0].trim();

function cardText(f: FollowUp, card: string, round: number, state: ReviewState): { name: string; desc: string } {
  const { finding, judgement } = f;
  return {
    name: `Follow-up${card ? ` ${card}` : ""}: ${finding.id} ${firstLine(finding.claim).slice(0, TITLE_LIMIT)}`,
    desc: [
      `The factory's review re-raised ${finding.id} after round ${round} on a narrower case of ${judgement.earlier_id}, `
        + "so the pull request was delivered and this case left to a follow-up.",
      "",
      `Finding ${finding.id} (first raised in round ${finding.round}):`,
      finding.claim,
      "",
      `Narrower case of ${judgement.earlier_id}: ${judgement.why}`,
      "",
      `Pull request: ${state.pr_url}`,
      `Review report: ${state.review_url}`,
    ].join("\n"),
  };
}

async function lists(readProfile: () => Promise<unknown>): Promise<Lists> {
  try {
    return listNames(await readProfile()).lists;
  } catch {
    return { ...DEFAULT_LISTS };
  }
}

export async function runFollowUp(input: FollowUpInput, deps: FollowUpDeps): Promise<FollowUpReport> {
  const delivery = parseJsonObject(input.delivery) ?? {};
  const report = (fields: Partial<FollowUpReport>): FollowUpReport => ({
    ...delivery,
    ready: delivery.ready === true,
    reason: String(delivery.reason ?? ""),
    pr_url: String(delivery.pr_url ?? ""),
    summary: String(delivery.summary ?? ""),
    followed_up: false,
    cards: [],
    warning: "",
    ...fields,
  });
  const notFollowed = (why: string, fields: Partial<FollowUpReport> = {}) =>
    report({ summary: `${String(delivery.summary ?? "")}\n\nNot followed up: ${why}.`, ...fields });

  const decision = decideFollowUp({ delivery, state: parseState(input.state), judge: parseJudge(input.judge) });
  if (decision.kind === "pass") return report({});
  if (decision.kind === "declined") return notFollowed(decision.reason);
  const facts = decision.state;

  const ref = parseCardRef(input.task) ?? parseCardRef(input.request);
  const card = ref === null ? "" : cardLabel(ref);
  const ids = decision.followups.map((f) => f.finding.id);
  const ready = (cards: CardResult[]) => report({
    ready: true,
    reason: "follow_up",
    summary: `Ready: follow-up after round ${decision.round}: ${ids.join(", ")} re-raised on `
      + `${ids.length === 1 ? "a narrower case of an earlier finding" : "narrower cases of earlier findings"}; `
      + `follow-up cards: ${cards.map((c) => `${c.finding} ${c.url || "(dry run)"}`).join("; ")}.\n${facts.pr_url}`,
    followed_up: true,
    cards,
  });

  if (runIdFrom(input.artifactsDir) === null) {
    return ready(ids.map((finding) => ({ finding, url: "", status: "dry-run" })));
  }
  const failed = ids.map((finding): CardResult => ({ finding, url: "", status: "failed" }));
  const writeFailed = (warning: string, cards: CardResult[]) => notFollowed(warning, { cards, warning });
  if (newestBody(input.artifactsDir) === null) {
    const warning = "no pr-body file in the run's artifacts to link the follow-up cards in";
    return writeFailed(warning, failed);
  }
  const creds = readCreds(input.envFile);
  if ("warning" in creds) return writeFailed(creds.warning, failed);

  const created = await createFollowUpCards(
    deps.fetch, creds, await lists(deps.readProfile),
    decision.followups.map((f) => ({ finding: f.finding.id, ...cardText(f, card, decision.round, facts) })),
  );
  if (created.warning !== "") return writeFailed(created.warning, created.cards);

  const section = ["## Follow-up cards", "", ...decision.followups.map((f, n) =>
    `- ${f.finding.id}: ${created.cards[n].url} — ${firstLine(f.finding.claim)}`), ""].join("\n");
  try {
    appendToNewestBody(input.artifactsDir, section);
  } catch (e) {
    const warning = `the follow-up cards could not be linked in the pull request body: ${e instanceof Error ? e.message : String(e)}`;
    return writeFailed(warning, created.cards);
  }
  if (facts.is_draft) {
    const marked = deps.gh(["pr", "ready", facts.pr_url]);
    if (!marked.ok) {
      const warning = `gh pr ready failed: ${marked.err}`;
      return writeFailed(warning, created.cards);
    }
  }
  return ready(created.cards);
}

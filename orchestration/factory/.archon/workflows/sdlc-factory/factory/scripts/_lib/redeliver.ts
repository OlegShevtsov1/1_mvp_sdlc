import { parseJsonObject } from "./io.ts";

export type LastDelivery = Record<string, unknown> & { retry_note: string };

// The report every later node reads (PILOT-301): the retry's when the first
// delivery ended failed and redeliver ran, else the first's, with retry_note
// saying why the retry ran and how it ended ("" when it did not run).
export function lastDelivery(firstRaw: string, retryRaw: string): LastDelivery {
  const first = parseJsonObject(firstRaw) ?? {};
  const retry = retryRaw === "" ? null : parseJsonObject(retryRaw);
  if (retry === null) return { ...first, retry_note: "" };
  const pr = [retry.pr_url, first.pr_url].find((url) => typeof url === "string" && url !== "");
  const ended = retry.ready === true ? "ready" : `not ready (${typeof retry.reason === "string" && retry.reason || "no reason given"})`;
  return {
    ...retry,
    retry_note:
      "the first delivery ended failed (a node inside the bundled delivery broke; the run's record names it), " +
      `so the factory ran one more delivery on the run's branch${pr ? ` and pull request ${pr}` : ""}, which ended ${ended}`,
  };
}

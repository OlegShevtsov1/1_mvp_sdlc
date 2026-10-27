import { emit } from "./_lib/io.ts";
import { ragReindex, ragSearch } from "./_lib/rag.ts";

// The mvp-rag client for shells (bin/rag) and the mvp-ops post-merge pack. Every server outcome is
// one JSON line and exit 0, so a caller can never be blocked by it; only a usage error exits 2.
const USAGE = "usage: rag search <query words...> [--k N] [--repo NAME] | rag reindex [--force]";

function usage(): void {
  process.stderr.write(USAGE + "\n");
  process.exitCode = 2;
}

function warn(warning: string): void {
  if (warning) process.stderr.write(`rag: warning: ${warning}\n`);
}

async function search(args: string[]): Promise<void> {
  const words: string[] = [];
  let k = 5;
  let repo: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--k") {
      k = Number(args[++i]);
      if (!Number.isInteger(k) || k < 1 || k > 20) return usage();
    } else if (a === "--repo") {
      repo = args[++i];
      if (!repo) return usage();
    } else if (a.startsWith("-")) {
      return usage();
    } else {
      words.push(a);
    }
  }
  const query = words.join(" ").trim();
  if (!query) return usage();
  const r = await ragSearch(query, { k, repo }, process.env);
  warn(r.warning);
  emit({ status: r.status, query, sources: r.sources, warning: r.warning });
}

async function reindex(args: string[]): Promise<void> {
  if (args.some((a) => a !== "--force")) return usage();
  const r = await ragReindex(args.includes("--force"), process.env);
  warn(r.warning);
  emit(r);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "--help" || command === "-h") process.stdout.write(USAGE + "\n");
else if (command === "search") await search(rest);
else if (command === "reindex") await reindex(rest);
else usage();

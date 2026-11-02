import { existsSync, readFileSync } from "node:fs";

// Flat `NAME=value` assignments, optionally exported or quoted; null when the file is missing.
export function readEnvFile(path: string): Record<string, string> | null {
  if (!existsSync(path)) return null;
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return env;
}

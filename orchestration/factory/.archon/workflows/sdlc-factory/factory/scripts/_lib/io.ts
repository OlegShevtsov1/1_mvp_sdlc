// Shared output discipline for every named script in this package.
// Never call process.exit(): Bun may leave without draining stdout.
export function emit(doc: unknown): void {
  process.stdout.write(JSON.stringify(doc) + "\n");
}

export function fail(message: string): void {
  process.stderr.write(message + "\n");
  process.exitCode = 1;
}

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const doc: unknown = JSON.parse(raw);
    return doc !== null && typeof doc === "object" && !Array.isArray(doc)
      ? (doc as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

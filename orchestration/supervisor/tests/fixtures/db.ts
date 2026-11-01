import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type RunRow = {
  id: string;
  workflow_name: string;
  user_message: string;
  status: string;
  metadata?: string;
  started_at?: string;
  completed_at?: string | null;
  last_activity_at?: string;
  working_path?: string | null;
};
export type EventRow = {
  id: string;
  workflow_run_id: string;
  event_order: number;
  event_type: string;
  step_name: string | null;
  data: string;
  created_at?: string;
};

export const FIXTURES = ["plan-gate-4a7a0367.json", "install-gate-ec459894.json", "post-merge-gate-c2154fea.json"];

// The columns Archon v0.12.1 has, without the foreign keys to tables the supervisor never reads.
export function fixtureDb(...files: string[]): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE remote_agent_workflow_runs (
    id TEXT PRIMARY KEY, workflow_name TEXT NOT NULL, user_message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', metadata TEXT DEFAULT '{}',
    started_at TEXT DEFAULT (datetime('now')), completed_at TEXT,
    last_activity_at TEXT DEFAULT (datetime('now')), working_path TEXT)`);
  db.run(`CREATE TABLE remote_agent_workflow_events (
    id TEXT PRIMARY KEY, workflow_run_id TEXT NOT NULL, event_order INTEGER,
    event_type TEXT NOT NULL, step_name TEXT, data TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')))`);
  for (const f of files) {
    const fixture = JSON.parse(readFileSync(join(import.meta.dir, f), "utf8")) as { run: RunRow; events: EventRow[] };
    insertRun(db, fixture.run);
    for (const e of fixture.events) insertEvent(db, e);
  }
  return db;
}

export function insertRun(db: Database, r: RunRow): void {
  db.query(`INSERT INTO remote_agent_workflow_runs
    (id, workflow_name, user_message, status, metadata, started_at, completed_at, last_activity_at, working_path)
    VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, COALESCE(?, datetime('now')), ?)`).run(
    r.id, r.workflow_name, r.user_message, r.status, r.metadata ?? "{}", r.started_at ?? null,
    r.completed_at ?? null, r.last_activity_at ?? null, r.working_path ?? null);
}

export function insertEvent(db: Database, e: EventRow): void {
  db.query(`INSERT INTO remote_agent_workflow_events
    (id, workflow_run_id, event_order, event_type, step_name, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`).run(
    e.id, e.workflow_run_id, e.event_order, e.event_type, e.step_name, e.data, e.created_at ?? null);
}

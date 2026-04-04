import { drizzle } from "drizzle-orm/bun-sqlite";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { Database as BunDatabase } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import * as schema from "@/storage/schema.ts";

const SQLITE_BUSY_TIMEOUT_MILLISECONDS = 5000;
const SQLITE_CACHE_SIZE_KB = 64000;

type DatabaseInstance = BunSQLiteDatabase<typeof schema> & { $client: BunDatabase };

let databaseInstance: DatabaseInstance | null = null;
let rawDatabaseConnection: BunDatabase | null = null;

export function getDataDirectory(): string {
  const homeDirectory = process.env.HOME ?? process.env.USERPROFILE ?? ".";
  const dataDirectory = join(homeDirectory, ".kraken", "data");
  mkdirSync(dataDirectory, { recursive: true });
  return dataDirectory;
}

export function getDatabase(): DatabaseInstance {
  if (databaseInstance) return databaseInstance;

  const databasePath = join(getDataDirectory(), "kraken.db");
  rawDatabaseConnection = new BunDatabase(databasePath);

  rawDatabaseConnection.exec("PRAGMA journal_mode = WAL");
  rawDatabaseConnection.exec("PRAGMA synchronous = NORMAL");
  rawDatabaseConnection.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MILLISECONDS}`);
  rawDatabaseConnection.exec(`PRAGMA cache_size = -${SQLITE_CACHE_SIZE_KB}`);
  rawDatabaseConnection.exec("PRAGMA foreign_keys = ON");

  rawDatabaseConnection.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      agent_id TEXT NOT NULL DEFAULT 'build',
      model TEXT NOT NULL DEFAULT '',
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    )
  `);

  rawDatabaseConnection.exec(`
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      time_created INTEGER NOT NULL
    )
  `);

  rawDatabaseConnection.exec(`
    CREATE INDEX IF NOT EXISTS message_session_idx ON message(session_id, time_created)
  `);

  rawDatabaseConnection.exec(`
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      tool_name TEXT,
      tool_call_id TEXT,
      tool_input TEXT,
      state TEXT,
      time_created INTEGER NOT NULL
    )
  `);

  rawDatabaseConnection.exec(`
    CREATE INDEX IF NOT EXISTS part_message_idx ON part(message_id)
  `);

  rawDatabaseConnection.exec(`
    CREATE INDEX IF NOT EXISTS part_session_idx ON part(session_id)
  `);

  runMigrations(rawDatabaseConnection);

  databaseInstance = drizzle(rawDatabaseConnection, { schema });

  return databaseInstance;
}

function runMigrations(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const appliedVersions = new Set(
    db
      .query<{ version: number }, []>("SELECT version FROM schema_migrations")
      .all()
      .map((row) => row.version),
  );

  const migrations: Array<{ version: number; sql: string }> = [
    { version: 1, sql: "ALTER TABLE session ADD COLUMN parent_id TEXT" },
  ];

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;
    db.exec(migration.sql);
    db.exec(`INSERT INTO schema_migrations (version) VALUES (${migration.version})`);
  }
}

export function closeDatabase(): void {
  if (rawDatabaseConnection) {
    rawDatabaseConnection.close();
    rawDatabaseConnection = null;
    databaseInstance = null;
  }
}

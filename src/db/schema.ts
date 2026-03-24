/**
 * SQLite schema definitions and migration runner for cc-analytics.
 */
import type Database from "better-sqlite3";

interface Migration {
  version: number;
  description: string;
  up: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Initial schema — api_calls + sessions tables",
    up: `
      CREATE TABLE IF NOT EXISTS api_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        message_id TEXT,
        timestamp TEXT NOT NULL,
        model TEXT,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        cache_read_tokens INTEGER DEFAULT 0,
        cache_creation_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER GENERATED ALWAYS AS
          (input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) STORED,
        rate_limit_tokens INTEGER GENERATED ALWAYS AS
          (input_tokens + output_tokens + cache_creation_tokens) STORED,
        team_name TEXT,
        agent_name TEXT,
        project_dir TEXT,
        source_version TEXT,
        UNIQUE(session_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        first_seen TEXT,
        last_seen TEXT,
        total_tokens INTEGER DEFAULT 0,
        rate_limit_tokens INTEGER DEFAULT 0,
        total_calls INTEGER DEFAULT 0,
        primary_model TEXT,
        team_name TEXT,
        agent_name TEXT,
        parent_session_id TEXT,
        project_dir TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_api_calls_session ON api_calls(session_id);
      CREATE INDEX IF NOT EXISTS idx_api_calls_timestamp ON api_calls(timestamp);
      CREATE INDEX IF NOT EXISTS idx_api_calls_team ON api_calls(team_name);
      CREATE INDEX IF NOT EXISTS idx_api_calls_project ON api_calls(project_dir);
      CREATE INDEX IF NOT EXISTS idx_sessions_first_seen ON sessions(first_seen);
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_dir);
    `,
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      description TEXT,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const currentVersion = db
    .prepare("SELECT MAX(version) as v FROM schema_version")
    .get() as { v: number | null };
  const applied = currentVersion?.v ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= applied) continue;

    db.transaction(() => {
      db.exec(migration.up);
      db.prepare("INSERT INTO schema_version (version, description) VALUES (?, ?)").run(
        migration.version,
        migration.description
      );
    })();
  }
}

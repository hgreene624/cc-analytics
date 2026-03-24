/**
 * SQLite database connection manager.
 */
import Database from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";
import { runMigrations } from "./schema.js";

const DEFAULT_DB_PATH = join(homedir(), ".claude", "cc-analytics.db");

let _db: Database.Database | null = null;

export function openDatabase(dbPath?: string): Database.Database {
  if (_db) return _db;

  const path = dbPath ?? DEFAULT_DB_PATH;
  _db = new Database(path);

  _db.pragma("journal_mode = WAL");
  _db.pragma("synchronous = NORMAL");
  _db.pragma("cache_size = -64000");

  runMigrations(_db);
  return _db;
}

export function closeDatabase(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

import { parseArgs } from "node:util";
import { discoverFiles } from "../discovery.js";
import { parseSessionFile } from "../parser.js";
import { openDatabase, closeDatabase } from "../db/connection.js";
import { parseTimeValue } from "../time.js";
import { formatTokens } from "../formatter.js";
import type { ApiCall } from "../parser.js";

function printHelp(): void {
  console.log(`
cc-analytics import — Import JSONL data into SQLite for faster queries

Usage:
  cc-analytics import [options]

Options:
  --since <value>   Import files modified since (ISO date, relative: 24h/7d, or: today/yesterday)
  --all             Import all JSONL files (no time filter)
  --db <path>       Database path (default: ~/.claude/cc-analytics.db)
  --help, -h        Show this help message

Examples:
  cc-analytics import --since today
  cc-analytics import --all
  cc-analytics import --since 7d
`);
}

function rebuildSessions(db: ReturnType<typeof openDatabase>): number {
  db.exec("DELETE FROM sessions");

  db.exec(`
    INSERT INTO sessions (session_id, first_seen, last_seen, total_tokens, rate_limit_tokens,
                          total_calls, primary_model, team_name, agent_name, project_dir)
    SELECT
      session_id,
      MIN(timestamp) as first_seen,
      MAX(timestamp) as last_seen,
      SUM(total_tokens) as total_tokens,
      SUM(rate_limit_tokens) as rate_limit_tokens,
      COUNT(*) as total_calls,
      (SELECT model FROM api_calls a2 WHERE a2.session_id = api_calls.session_id
       GROUP BY model ORDER BY COUNT(*) DESC LIMIT 1) as primary_model,
      MAX(team_name) as team_name,
      MAX(agent_name) as agent_name,
      MAX(project_dir) as project_dir
    FROM api_calls
    GROUP BY session_id
  `);

  const count = db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number };
  return count.c;
}

export async function runImport(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      since: { type: "string" },
      all: { type: "boolean", default: false },
      db: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  if (!values.since && !values.all) {
    console.error("Error: Specify --since <value> or --all to import data.");
    console.error("Run 'cc-analytics import --help' for usage.");
    process.exit(1);
  }

  const since = values.since ? parseTimeValue(values.since) : undefined;

  console.log("Discovering JSONL files...");
  const files = await discoverFiles({ since });

  if (files.length === 0) {
    console.log("No JSONL files found in the specified time window.");
    return;
  }

  console.log(`Found ${files.length} JSONL files to process.`);

  const db = openDatabase(values.db);

  const insertCall = db.prepare(`
    INSERT OR IGNORE INTO api_calls
      (session_id, message_id, timestamp, model,
       input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       team_name, agent_name, project_dir, source_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalCalls = 0;
  let insertedCalls = 0;
  let skippedDuplicates = 0;
  let filesProcessed = 0;

  const insertBatch = db.transaction((calls: ApiCall[], projectDir: string) => {
    for (const call of calls) {
      totalCalls++;
      const result = insertCall.run(
        call.sessionId,
        call.messageId,
        call.timestamp,
        call.model,
        call.inputTokens,
        call.outputTokens,
        call.cacheReadTokens,
        call.cacheCreationTokens,
        call.teamName ?? null,
        call.agentName ?? null,
        projectDir,
        call.sourceVersion ?? null
      );
      if (result.changes > 0) {
        insertedCalls++;
      } else {
        skippedDuplicates++;
      }
    }
  });

  for (const file of files) {
    try {
      const calls = await parseSessionFile(file.path);
      if (calls.length > 0) {
        let projectDir: string;
        try {
          projectDir = decodeURIComponent(file.projectSlug);
        } catch {
          projectDir = file.projectSlug;
        }
        insertBatch(calls, projectDir);
      }
      filesProcessed++;

      if (filesProcessed % 50 === 0) {
        process.stdout.write(`  Processed ${filesProcessed}/${files.length} files...\r`);
      }
    } catch {
      filesProcessed++;
    }
  }

  process.stdout.write("\n");

  console.log("Rebuilding sessions table...");
  const sessionCount = rebuildSessions(db);

  const totals = db
    .prepare("SELECT SUM(total_tokens) as t, SUM(rate_limit_tokens) as r FROM api_calls")
    .get() as { t: number; r: number };

  closeDatabase();

  console.log(`
Import complete:
  Files processed:    ${filesProcessed}
  API calls found:    ${totalCalls}
  New calls inserted: ${insertedCalls}
  Duplicates skipped: ${skippedDuplicates}
  Sessions:           ${sessionCount}
  Total tokens (DB):  ${formatTokens(totals.t)}
  Rate limit tokens:  ${formatTokens(totals.r)}
`);
}

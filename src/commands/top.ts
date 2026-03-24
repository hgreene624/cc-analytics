import { parseArgs } from "node:util";
import { discoverFiles } from "../discovery.js";
import { parseSessionFile } from "../parser.js";
import { aggregateSessions } from "../aggregator.js";
import { parseTimeValue } from "../time.js";
import {
  formatTokens,
  formatDuration,
  formatTime,
  truncateSessionId,
  markdownTable,
  formatProjectDir,
} from "../formatter.js";
import { openDatabase, closeDatabase } from "../db/connection.js";
import { querySessions } from "../db/queries.js";
import type { ApiCall } from "../parser.js";

function printHelp(): void {
  console.log(`
cc-analytics top — Top N sessions by token usage

Usage:
  cc-analytics top [options]

Options:
  --since <value>   Start of time window (ISO date, relative: 24h/7d, or: today/yesterday)
  --until <value>   End of time window (same formats as --since)
  -n <number>       Number of sessions to show (default: 10)
  --by <field>      Sort by: total (default) or rate_limit
  --json            Output as JSON instead of markdown
  --help, -h        Show this help message

Examples:
  cc-analytics top --since today
  cc-analytics top --since 5am --until 9am -n 5
  cc-analytics top --since 7d --by rate_limit
`);
}

export async function runTop(args: string[], useDb = false): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      since: { type: "string" },
      until: { type: "string" },
      n: { type: "string", default: "10" },
      by: { type: "string", default: "total" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  const since = values.since ? parseTimeValue(values.since) : undefined;
  const until = values.until ? parseTimeValue(values.until) : undefined;
  const limit = parseInt(values.n!, 10) || 10;
  const sortBy = values.by === "rate_limit" ? "rate_limit" : "total";

  let sessions;
  if (useDb) {
    const db = openDatabase();
    sessions = querySessions(db, { since, until });
    closeDatabase();
  } else {
    const files = await discoverFiles({ since, until });
    if (files.length === 0) {
      console.log("No JSONL files found in the specified time window.");
      return;
    }
    const callsByFile = new Map<string, ApiCall[]>();
    for (const file of files) {
      try {
        const calls = await parseSessionFile(file.path);
        if (calls.length > 0) callsByFile.set(file.path, calls);
      } catch { /* skip */ }
    }
    sessions = aggregateSessions(files, callsByFile);
  }

  // Sort by chosen field
  if (sortBy === "rate_limit") {
    sessions.sort((a, b) => b.rateLimitTokens - a.rateLimitTokens);
  } else {
    sessions.sort((a, b) => b.totalTokens - a.totalTokens);
  }

  const topSessions = sessions.slice(0, limit);

  if (values.json) {
    console.log(JSON.stringify(topSessions, null, 2));
    return;
  }

  const grandTotal = sessions.reduce((sum, s) => sum + s.totalTokens, 0);
  console.log(
    `\n**Top ${topSessions.length} Sessions** (of ${sessions.length} total, ${formatTokens(grandTotal)} tokens, sorted by ${sortBy === "rate_limit" ? "rate_limit_tokens" : "total_tokens"})\n`
  );

  if (topSessions.length === 0) {
    console.log("No sessions found.");
    return;
  }

  const headers = ["#", "Session", "Project", "Start", "Duration", "Tokens", "Rate Limit", "Model", "Team"];
  const rows = topSessions.map((s, i) => [
    String(i + 1),
    truncateSessionId(s.sessionId),
    formatProjectDir(s.projectDir),
    formatTime(s.firstSeen),
    formatDuration(s.durationMs),
    formatTokens(s.totalTokens),
    formatTokens(s.rateLimitTokens),
    s.primaryModel.replace("claude-", ""),
    s.teamName ?? "-",
  ]);

  console.log(markdownTable(headers, rows));
}

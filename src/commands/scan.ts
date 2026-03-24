import { parseArgs } from "node:util";
import { discoverFiles } from "../discovery.js";
import { parseSessionFile } from "../parser.js";
import { aggregateSessions, type SessionSummary } from "../aggregator.js";
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
cc-analytics scan — Build session inventory from JSONL files

Usage:
  cc-analytics scan [options]

Options:
  --since <value>   Start of time window (ISO date, relative: 24h/7d, or: today/yesterday)
  --until <value>   End of time window (same formats as --since)
  --json            Output as JSON array instead of markdown table
  --help, -h        Show this help message

Examples:
  cc-analytics scan --since today
  cc-analytics scan --since 24h
  cc-analytics scan --since 2026-03-20 --until 2026-03-24
  cc-analytics scan --since 7d --json
`);
}

export async function runScan(args: string[], useDb = false): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      since: { type: "string" },
      until: { type: "string" },
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

  let sessions: SessionSummary[];
  let totalFiles = 0;
  let parseErrors = 0;

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
    totalFiles = files.length;
    const callsByFile = new Map<string, ApiCall[]>();
    for (const file of files) {
      try {
        const calls = await parseSessionFile(file.path);
        if (calls.length > 0) callsByFile.set(file.path, calls);
      } catch { parseErrors++; }
    }
    sessions = aggregateSessions(files, callsByFile);
  }

  // Output
  if (values.json) {
    console.log(JSON.stringify(sessions, null, 2));
    return;
  }

  // Summary line
  const totalSessions = sessions.length;
  const totalSubagents = sessions.reduce((sum, s) => sum + s.subagentSessions.length, 0);
  const grandTotal = sessions.reduce((sum, s) => sum + s.totalTokens, 0);

  console.log(`\n**Scan Results** — ${useDb ? "SQLite" : `${totalFiles} files`}, ${totalSessions} sessions` +
    (totalSubagents > 0 ? ` (${totalSubagents} subagent)` : "") +
    `, ${formatTokens(grandTotal)} total tokens` +
    (parseErrors > 0 ? ` (${parseErrors} parse errors)` : "") +
    "\n");

  if (sessions.length === 0) {
    console.log("No sessions with API calls found.");
    return;
  }

  // Render table
  const headers = ["Session", "Project", "Start", "Duration", "Tokens", "Rate Limit", "Model", "Team", "Agents"];
  const rows: string[][] = sessions.map((s) => [
    truncateSessionId(s.sessionId),
    formatProjectDir(s.projectDir),
    formatTime(s.firstSeen),
    formatDuration(s.durationMs),
    formatTokens(s.totalTokens),
    formatTokens(s.rateLimitTokens),
    s.primaryModel.replace("claude-", ""),
    s.teamName ?? "-",
    s.agents.length > 0 ? formatAgents(s) : "-",
  ]);

  console.log(markdownTable(headers, rows));

  // Show subagent details if any
  const sessionsWithSubs = sessions.filter((s) => s.subagentSessions.length > 0);
  if (sessionsWithSubs.length > 0) {
    console.log("\n**Subagent Details**\n");
    for (const parent of sessionsWithSubs) {
      console.log(`Session ${truncateSessionId(parent.sessionId)} (${parent.teamName ?? "unnamed team"}):`);
      for (const sub of parent.subagentSessions) {
        console.log(
          `  └─ ${sub.agents[0] ?? truncateSessionId(sub.sessionId)}: ` +
          `${formatTokens(sub.totalTokens)} tokens, ${sub.totalCalls} calls, ` +
          `${sub.primaryModel.replace("claude-", "")}`
        );
      }
      console.log();
    }
  }
}

function formatAgents(session: SessionSummary): string {
  const count = session.agents.length + session.subagentSessions.length;
  if (count <= 2) {
    return [...session.agents, ...session.subagentSessions.map((s) => s.agents[0] ?? "?")]
      .filter(Boolean)
      .slice(0, 3)
      .join(", ");
  }
  return `${count} agents`;
}

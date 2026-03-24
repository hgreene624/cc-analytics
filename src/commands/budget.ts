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
  formatPercent,
  formatProjectDir,
} from "../formatter.js";
import { openDatabase, closeDatabase } from "../db/connection.js";
import { queryApiCalls, querySessions } from "../db/queries.js";
import type { ApiCall } from "../parser.js";

function printHelp(): void {
  console.log(`
cc-analytics budget — Rolling window budget analysis

Usage:
  cc-analytics budget [options]

Options:
  --at <timestamp>  End of the window (ISO datetime, default: now)
  --window <value>  Window duration (e.g., 5h, 3h, default: 5h)
  --json            Output as JSON instead of markdown
  --help, -h        Show this help message

Examples:
  cc-analytics budget
  cc-analytics budget --at "2026-03-24T08:25:00"
  cc-analytics budget --window 3h
  cc-analytics budget --at "2026-03-24T08:25:00" --json
`);
}

/**
 * Parse a window duration string (e.g., "5h", "3h", "90m") into milliseconds.
 */
function parseWindowDuration(value: string): number {
  const match = value.match(/^(\d+)(h|m)$/);
  if (!match) throw new Error(`Invalid window duration: "${value}". Use format like 5h or 90m.`);
  const amount = parseInt(match[1], 10);
  const unit = match[2];
  return unit === "h" ? amount * 3600_000 : amount * 60_000;
}

export async function runBudget(args: string[], useDb = false): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      at: { type: "string" },
      window: { type: "string", default: "5h" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  const windowEnd = values.at ? parseTimeValue(values.at) : new Date();
  const windowMs = parseWindowDuration(values.window!);
  const windowStart = new Date(windowEnd.getTime() - windowMs);

  let windowCalls: ApiCall[];
  let sessionInfoMap: Map<string, { projectDir: string; teamName?: string }>;

  if (useDb) {
    const db = openDatabase();
    windowCalls = queryApiCalls(db, { since: windowStart, until: windowEnd });
    const dbSessions = querySessions(db, { since: windowStart, until: windowEnd });
    sessionInfoMap = new Map(dbSessions.map((s) => [s.sessionId, { projectDir: s.projectDir, teamName: s.teamName }]));
    closeDatabase();
  } else {
    const margin = 3600_000;
    const files = await discoverFiles({
      since: new Date(windowStart.getTime() - margin),
      until: new Date(windowEnd.getTime() + margin),
    });
    if (files.length === 0) {
      console.log("No JSONL files found in the specified window.");
      return;
    }
    const callsByFile = new Map<string, ApiCall[]>();
    const allCalls: ApiCall[] = [];
    for (const file of files) {
      try {
        const calls = await parseSessionFile(file.path);
        if (calls.length > 0) { callsByFile.set(file.path, calls); allCalls.push(...calls); }
      } catch { /* skip */ }
    }
    windowCalls = allCalls.filter((c) => {
      const t = new Date(c.timestamp).getTime();
      return t >= windowStart.getTime() && t <= windowEnd.getTime();
    });
    const sessions = aggregateSessions(files, callsByFile);
    sessionInfoMap = new Map(sessions.map((s) => [s.sessionId, { projectDir: s.projectDir, teamName: s.teamName }]));
  }

  if (windowCalls.length === 0) {
    console.log(`No API calls found in window ${formatTime(windowStart.toISOString())} → ${formatTime(windowEnd.toISOString())}.`);
    return;
  }

  // Sort by timestamp
  windowCalls.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  // Aggregate by session
  const sessionMap = new Map<string, { calls: ApiCall[]; totalTokens: number; rateLimitTokens: number }>();
  let totalTokens = 0;
  let rateLimitTokens = 0;

  for (const call of windowCalls) {
    totalTokens += call.totalTokens;
    rateLimitTokens += call.rateLimitTokens;

    if (!sessionMap.has(call.sessionId)) {
      sessionMap.set(call.sessionId, { calls: [], totalTokens: 0, rateLimitTokens: 0 });
    }
    const entry = sessionMap.get(call.sessionId)!;
    entry.calls.push(call);
    entry.totalTokens += call.totalTokens;
    entry.rateLimitTokens += call.rateLimitTokens;
  }

  // Acceleration detection: find per-minute rates and detect spike
  const minuteBuckets = new Map<number, number>();
  for (const call of windowCalls) {
    const t = new Date(call.timestamp).getTime();
    const minuteKey = Math.floor(t / 60_000);
    minuteBuckets.set(minuteKey, (minuteBuckets.get(minuteKey) ?? 0) + call.totalTokens);
  }

  const minuteRates = Array.from(minuteBuckets.entries()).sort((a, b) => a[0] - b[0]);
  const avgRate = minuteRates.length > 0
    ? minuteRates.reduce((sum, [, tokens]) => sum + tokens, 0) / minuteRates.length
    : 0;

  // Find acceleration point: first minute where rate > 2x average
  let accelerationPoint: { time: Date; rate: number } | null = null;
  for (const [minuteKey, tokens] of minuteRates) {
    if (tokens > avgRate * 2) {
      accelerationPoint = { time: new Date(minuteKey * 60_000), rate: tokens };
      break;
    }
  }

  if (values.json) {
    const sessionContributions = Array.from(sessionMap.entries())
      .map(([sid, data]) => ({
        sessionId: sid,
        totalTokens: data.totalTokens,
        rateLimitTokens: data.rateLimitTokens,
        callCount: data.calls.length,
        percentOfTotal: totalTokens > 0 ? data.totalTokens / totalTokens : 0,
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    console.log(JSON.stringify({
      window: {
        start: windowStart.toISOString(),
        end: windowEnd.toISOString(),
        durationMs: windowMs,
      },
      summary: { totalTokens, rateLimitTokens, sessionCount: sessionMap.size, callCount: windowCalls.length },
      accelerationPoint: accelerationPoint
        ? { time: accelerationPoint.time.toISOString(), tokensPerMinute: accelerationPoint.rate }
        : null,
      sessions: sessionContributions,
    }, null, 2));
    return;
  }

  // Window summary
  console.log(`\n**Budget Window** — ${formatTime(windowStart.toISOString())} → ${formatTime(windowEnd.toISOString())} (${values.window})\n`);
  console.log(`- **Total Tokens:** ${formatTokens(totalTokens)}`);
  console.log(`- **Rate Limit Tokens:** ${formatTokens(rateLimitTokens)}`);
  console.log(`- **Sessions:** ${sessionMap.size}`);
  console.log(`- **API Calls:** ${windowCalls.length}`);
  console.log(`- **Avg Tokens/Min:** ${formatTokens(Math.round(avgRate))}`);

  if (accelerationPoint) {
    console.log(`- **Acceleration Detected:** ${formatTime(accelerationPoint.time.toISOString())} — ${formatTokens(accelerationPoint.rate)} tokens/min (${(accelerationPoint.rate / avgRate).toFixed(1)}x average)`);
  } else {
    console.log(`- **Acceleration:** No spike detected (no minute exceeded 2x average rate)`);
  }

  // Session contribution table
  console.log(`\n**Session Contributions** (sorted by token usage)\n`);

  const sortedSessions = Array.from(sessionMap.entries())
    .sort((a, b) => b[1].totalTokens - a[1].totalTokens);

  const headers = ["#", "Session", "Project", "Tokens", "Rate Limit", "% Total", "Calls", "Team"];
  const rows = sortedSessions.map(([sid, data], i) => {
    const info = sessionInfoMap.get(sid);
    return [
      String(i + 1),
      truncateSessionId(sid),
      info ? formatProjectDir(info.projectDir) : "-",
      formatTokens(data.totalTokens),
      formatTokens(data.rateLimitTokens),
      formatPercent(totalTokens > 0 ? data.totalTokens / totalTokens : 0),
      String(data.calls.length),
      info?.teamName ?? "-",
    ];
  });

  console.log(markdownTable(headers, rows));
}

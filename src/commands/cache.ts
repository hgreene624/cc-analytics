import { parseArgs } from "node:util";
import { discoverFiles } from "../discovery.js";
import { parseSessionFile } from "../parser.js";
import { aggregateSessions } from "../aggregator.js";
import { parseTimeValue } from "../time.js";
import {
  formatTokens,
  formatPercent,
  truncateSessionId,
  markdownTable,
  formatProjectDir,
} from "../formatter.js";
import { openDatabase, closeDatabase } from "../db/connection.js";
import { querySessions, queryApiCalls } from "../db/queries.js";
import type { ApiCall } from "../parser.js";

function printHelp(): void {
  console.log(`
cc-analytics cache — Cache efficiency report

Usage:
  cc-analytics cache [options]

Options:
  --since <value>   Start of time window (ISO date, relative: 24h/7d, or: today/yesterday)
  --until <value>   End of time window (same formats as --since)
  --json            Output as JSON instead of markdown
  --help, -h        Show this help message

Examples:
  cc-analytics cache --since today
  cc-analytics cache --since 7d
  cc-analytics cache --since 7d --json
`);
}

interface SessionCacheStats {
  sessionId: string;
  projectDir: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheEfficiency: number;
  totalTokens: number;
}

interface ProjectCacheStats {
  projectDir: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheEfficiency: number;
  sessionCount: number;
}

export async function runCache(args: string[], useDb = false): Promise<void> {
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

  let sessions;
  let allCalls: ApiCall[];
  if (useDb) {
    const db = openDatabase();
    sessions = querySessions(db, { since, until });
    allCalls = queryApiCalls(db, { since, until });
    closeDatabase();
  } else {
    const files = await discoverFiles({ since, until });
    if (files.length === 0) {
      console.log("No JSONL files found in the specified time window.");
      return;
    }

    const callsByFile = new Map<string, ApiCall[]>();
    allCalls = [];
    for (const file of files) {
      try {
        const calls = await parseSessionFile(file.path);
        if (calls.length > 0) {
          callsByFile.set(file.path, calls);
          allCalls.push(...calls);
        }
      } catch { /* skip */ }
    }

    sessions = aggregateSessions(files, callsByFile);
  }

  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }

  // Per-session cache stats
  const sessionCallsMap = new Map<string, ApiCall[]>();
  for (const call of allCalls) {
    if (!sessionCallsMap.has(call.sessionId)) {
      sessionCallsMap.set(call.sessionId, []);
    }
    sessionCallsMap.get(call.sessionId)!.push(call);
  }

  const sessionStats: SessionCacheStats[] = sessions.map((s) => {
    const calls = sessionCallsMap.get(s.sessionId) ?? [];
    const inputTokens = calls.reduce((sum, c) => sum + c.inputTokens + c.cacheReadTokens, 0);
    const cacheReadTokens = calls.reduce((sum, c) => sum + c.cacheReadTokens, 0);
    const cacheEfficiency = inputTokens > 0 ? cacheReadTokens / inputTokens : 0;
    return {
      sessionId: s.sessionId,
      projectDir: s.projectDir,
      inputTokens,
      cacheReadTokens,
      cacheEfficiency,
      totalTokens: s.totalTokens,
    };
  });

  // Sort by efficiency ascending (worst first)
  sessionStats.sort((a, b) => a.cacheEfficiency - b.cacheEfficiency);

  // Per-project aggregate cache stats
  const projectMap = new Map<string, { inputTokens: number; cacheReadTokens: number; sessionCount: number }>();
  for (const s of sessionStats) {
    if (!projectMap.has(s.projectDir)) {
      projectMap.set(s.projectDir, { inputTokens: 0, cacheReadTokens: 0, sessionCount: 0 });
    }
    const entry = projectMap.get(s.projectDir)!;
    entry.inputTokens += s.inputTokens;
    entry.cacheReadTokens += s.cacheReadTokens;
    entry.sessionCount += 1;
  }

  const projectStats: ProjectCacheStats[] = Array.from(projectMap.entries())
    .map(([dir, data]) => ({
      projectDir: dir,
      inputTokens: data.inputTokens,
      cacheReadTokens: data.cacheReadTokens,
      cacheEfficiency: data.inputTokens > 0 ? data.cacheReadTokens / data.inputTokens : 0,
      sessionCount: data.sessionCount,
    }))
    .sort((a, b) => a.cacheEfficiency - b.cacheEfficiency);

  if (values.json) {
    console.log(JSON.stringify({ sessions: sessionStats, projects: projectStats }, null, 2));
    return;
  }

  // Overall stats
  const totalInput = sessionStats.reduce((sum, s) => sum + s.inputTokens, 0);
  const totalCacheRead = sessionStats.reduce((sum, s) => sum + s.cacheReadTokens, 0);
  const overallEfficiency = totalInput > 0 ? totalCacheRead / totalInput : 0;

  console.log(`\n**Cache Efficiency Report** — ${formatPercent(overallEfficiency)} overall efficiency\n`);
  console.log(`- **Total Input (incl. cache):** ${formatTokens(totalInput)}`);
  console.log(`- **Cache Read:** ${formatTokens(totalCacheRead)}`);
  console.log(`- **Sessions:** ${sessionStats.length}`);

  // Per-project table
  console.log(`\n**By Project** (sorted by efficiency, worst first)\n`);

  const projHeaders = ["#", "Project", "Efficiency", "Cache Read", "Total Input", "Sessions"];
  const projRows = projectStats.map((p, i) => [
    String(i + 1),
    formatProjectDir(p.projectDir),
    formatPercent(p.cacheEfficiency),
    formatTokens(p.cacheReadTokens),
    formatTokens(p.inputTokens),
    String(p.sessionCount),
  ]);

  console.log(markdownTable(projHeaders, projRows));

  // Per-session table (top 20 worst)
  const showCount = Math.min(20, sessionStats.length);
  console.log(`\n**By Session** (${showCount} worst of ${sessionStats.length}, sorted by efficiency)\n`);

  const sessHeaders = ["#", "Session", "Project", "Efficiency", "Cache Read", "Total Input", "Tokens"];
  const sessRows = sessionStats.slice(0, showCount).map((s, i) => [
    String(i + 1),
    truncateSessionId(s.sessionId),
    formatProjectDir(s.projectDir),
    formatPercent(s.cacheEfficiency),
    formatTokens(s.cacheReadTokens),
    formatTokens(s.inputTokens),
    formatTokens(s.totalTokens),
  ]);

  console.log(markdownTable(sessHeaders, sessRows));
}

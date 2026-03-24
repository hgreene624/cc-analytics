import { parseArgs } from "node:util";
import { discoverFiles } from "../discovery.js";
import { parseSessionFile } from "../parser.js";
import { aggregateSessions } from "../aggregator.js";
import { parseTimeValue } from "../time.js";
import {
  formatTokens,
  formatPercent,
  markdownTable,
  formatProjectDir,
} from "../formatter.js";
import type { ApiCall } from "../parser.js";

function printHelp(): void {
  console.log(`
cc-analytics projects — Token usage by project directory

Usage:
  cc-analytics projects [options]

Options:
  --since <value>   Start of time window (ISO date, relative: 24h/7d, or: today/yesterday)
  --until <value>   End of time window (same formats as --since)
  --json            Output as JSON instead of markdown
  --help, -h        Show this help message

Examples:
  cc-analytics projects --since today
  cc-analytics projects --since 7d
  cc-analytics projects --since 7d --json
`);
}

interface ProjectStats {
  projectDir: string;
  totalTokens: number;
  sessionCount: number;
  avgSessionSize: number;
  percentOfTotal: number;
  rateLimitTokens: number;
}

export async function runProjects(args: string[]): Promise<void> {
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

  const sessions = aggregateSessions(files, callsByFile);

  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }

  // Group by project directory
  const projectMap = new Map<string, { totalTokens: number; rateLimitTokens: number; sessionCount: number }>();

  for (const session of sessions) {
    const dir = session.projectDir;
    if (!projectMap.has(dir)) {
      projectMap.set(dir, { totalTokens: 0, rateLimitTokens: 0, sessionCount: 0 });
    }
    const entry = projectMap.get(dir)!;
    entry.totalTokens += session.totalTokens;
    entry.rateLimitTokens += session.rateLimitTokens;
    entry.sessionCount += 1;
  }

  const grandTotal = sessions.reduce((sum, s) => sum + s.totalTokens, 0);

  const projects: ProjectStats[] = Array.from(projectMap.entries())
    .map(([dir, data]) => ({
      projectDir: dir,
      totalTokens: data.totalTokens,
      sessionCount: data.sessionCount,
      avgSessionSize: data.sessionCount > 0 ? Math.round(data.totalTokens / data.sessionCount) : 0,
      percentOfTotal: grandTotal > 0 ? data.totalTokens / grandTotal : 0,
      rateLimitTokens: data.rateLimitTokens,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  if (values.json) {
    console.log(JSON.stringify({ projects, summary: { grandTotal, totalSessions: sessions.length } }, null, 2));
    return;
  }

  console.log(`\n**Project Usage** — ${formatTokens(grandTotal)} total tokens, ${sessions.length} sessions\n`);

  const headers = ["#", "Project", "Total Tokens", "% of Total", "Sessions", "Avg/Session", "Rate Limit"];
  const rows = projects.map((p, i) => [
    String(i + 1),
    formatProjectDir(p.projectDir),
    formatTokens(p.totalTokens),
    formatPercent(p.percentOfTotal),
    String(p.sessionCount),
    formatTokens(p.avgSessionSize),
    formatTokens(p.rateLimitTokens),
  ]);

  console.log(markdownTable(headers, rows));
}

import { parseArgs } from "node:util";
import { discoverFiles } from "../discovery.js";
import { parseSessionFile } from "../parser.js";
import { aggregateSessions } from "../aggregator.js";
import {
  formatTokens,
  markdownTable,
} from "../formatter.js";
import type { ApiCall } from "../parser.js";

function printHelp(): void {
  console.log(`
cc-analytics trend — Daily token usage trend

Usage:
  cc-analytics trend [options]

Options:
  --days <number>   Number of days to show (default: 14)
  --json            Output as JSON instead of markdown
  --help, -h        Show this help message

Examples:
  cc-analytics trend
  cc-analytics trend --days 7
  cc-analytics trend --days 30 --json
`);
}

interface DayStats {
  date: string;
  totalTokens: number;
  rateLimitTokens: number;
  sessionCount: number;
  avgSessionSize: number;
  movingAvg7d: number | null;
  isOutlier: boolean;
}

export async function runTrend(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      days: { type: "string", default: "14" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  const numDays = parseInt(values.days!, 10) || 14;

  // Calculate time window
  const now = new Date();
  const since = new Date(now);
  since.setDate(since.getDate() - numDays);
  since.setHours(0, 0, 0, 0);

  // Discover and parse
  const files = await discoverFiles({ since });
  if (files.length === 0) {
    console.log("No JSONL files found in the specified time window.");
    return;
  }

  const callsByFile = new Map<string, ApiCall[]>();
  const allCalls: ApiCall[] = [];

  for (const file of files) {
    try {
      const calls = await parseSessionFile(file.path);
      if (calls.length > 0) {
        callsByFile.set(file.path, calls);
        allCalls.push(...calls);
      }
    } catch { /* skip */ }
  }

  // Group calls by date (local timezone)
  const dayMap = new Map<string, { tokens: number; rateLimitTokens: number; sessions: Set<string> }>();

  for (const call of allCalls) {
    const d = new Date(call.timestamp);
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    if (!dayMap.has(dateKey)) {
      dayMap.set(dateKey, { tokens: 0, rateLimitTokens: 0, sessions: new Set() });
    }
    const entry = dayMap.get(dateKey)!;
    entry.tokens += call.totalTokens;
    entry.rateLimitTokens += call.rateLimitTokens;
    entry.sessions.add(call.sessionId);
  }

  // Build day list for the requested range
  const days: DayStats[] = [];
  const dailyTotals: number[] = [];

  for (let i = 0; i < numDays; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - (numDays - 1 - i));
    const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    const entry = dayMap.get(dateKey);
    const totalTokens = entry?.tokens ?? 0;
    const rateLimitTokens = entry?.rateLimitTokens ?? 0;
    const sessionCount = entry?.sessions.size ?? 0;
    const avgSessionSize = sessionCount > 0 ? Math.round(totalTokens / sessionCount) : 0;

    dailyTotals.push(totalTokens);

    // 7-day moving average
    let movingAvg7d: number | null = null;
    if (dailyTotals.length >= 7) {
      const last7 = dailyTotals.slice(-7);
      movingAvg7d = Math.round(last7.reduce((a, b) => a + b, 0) / 7);
    }

    days.push({
      date: dateKey,
      totalTokens,
      rateLimitTokens,
      sessionCount,
      avgSessionSize,
      movingAvg7d,
      isOutlier: false, // computed below
    });
  }

  // Compute mean and stddev for outlier detection
  const nonZeroDays = days.filter((d) => d.totalTokens > 0);
  if (nonZeroDays.length > 0) {
    const mean = nonZeroDays.reduce((sum, d) => sum + d.totalTokens, 0) / nonZeroDays.length;
    const variance = nonZeroDays.reduce((sum, d) => sum + (d.totalTokens - mean) ** 2, 0) / nonZeroDays.length;
    const stddev = Math.sqrt(variance);
    const threshold = mean + 2 * stddev;

    for (const day of days) {
      if (day.totalTokens > threshold) {
        day.isOutlier = true;
      }
    }
  }

  if (values.json) {
    console.log(JSON.stringify({ days, summary: computeSummary(days) }, null, 2));
    return;
  }

  // Render table
  console.log(`\n**Daily Usage Trend** — Last ${numDays} days\n`);

  const headers = ["Date", "Total Tokens", "Rate Limit", "Sessions", "Avg/Session", "7d Moving Avg", ""];
  const rows = days.map((d) => [
    d.date,
    formatTokens(d.totalTokens),
    formatTokens(d.rateLimitTokens),
    String(d.sessionCount),
    formatTokens(d.avgSessionSize),
    d.movingAvg7d !== null ? formatTokens(d.movingAvg7d) : "-",
    d.isOutlier ? "⚠" : "",
  ]);

  console.log(markdownTable(headers, rows));

  // Summary
  const summary = computeSummary(days);
  console.log(`\n**Summary:** ${formatTokens(summary.periodTotal)} total over ${numDays} days — ` +
    `${formatTokens(summary.dailyAverage)} daily average, ` +
    `${summary.activeDays} active days, ` +
    `${summary.outlierDays} outlier day${summary.outlierDays !== 1 ? "s" : ""}`
  );
}

function computeSummary(days: DayStats[]) {
  const periodTotal = days.reduce((sum, d) => sum + d.totalTokens, 0);
  const activeDays = days.filter((d) => d.totalTokens > 0).length;
  const dailyAverage = activeDays > 0 ? Math.round(periodTotal / activeDays) : 0;
  const outlierDays = days.filter((d) => d.isOutlier).length;
  return { periodTotal, activeDays, dailyAverage, outlierDays };
}

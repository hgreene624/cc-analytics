import { parseArgs } from "node:util";
import { discoverFiles } from "../discovery.js";
import { parseSessionFile } from "../parser.js";
import { aggregateSessions } from "../aggregator.js";
import { parseTimeValue } from "../time.js";
import type { SessionSummary } from "../aggregator.js";
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
cc-analytics compare — Compare two time periods

Usage:
  cc-analytics compare --a <period> --b <period> [options]

Period Formats:
  Relative:     7d, 14d, 24h
  Named:        today, yesterday, this-week, last-week
  Range:        14d..8d (from 14 days ago to 8 days ago)
  ISO:          2026-03-17..2026-03-24

Options:
  --a <period>    First period (more recent, typically "this week")
  --b <period>    Second period (baseline, typically "last week")
  --json          Output as JSON instead of markdown
  --help, -h      Show this help message

Examples:
  cc-analytics compare --a 7d --b 14d..8d
  cc-analytics compare --a this-week --b last-week
  cc-analytics compare --a today --b yesterday
`);
}

interface PeriodRange {
  since: Date;
  until: Date;
  label: string;
}

interface PeriodStats {
  label: string;
  totalTokens: number;
  callTotal: number; // sum of all raw API call tokens (for model % denominator)
  sessionCount: number;
  avgSessionSize: number;
  modelDistribution: Map<string, number>;
  cacheEfficiency: number;
  teamTokens: number;
  soloTokens: number;
  teamPercent: number;
  topSessions: SessionSummary[];
}

/**
 * Parse a period argument into a date range.
 * Supports: "7d", "today", "yesterday", "this-week", "last-week", "14d..8d", ISO ranges.
 */
function parsePeriod(value: string): PeriodRange {
  const now = new Date();
  const lower = value.toLowerCase().trim();

  // Named periods
  if (lower === "today") {
    const since = new Date(now);
    since.setHours(0, 0, 0, 0);
    return { since, until: now, label: "Today" };
  }

  if (lower === "yesterday") {
    const since = new Date(now);
    since.setDate(since.getDate() - 1);
    since.setHours(0, 0, 0, 0);
    const until = new Date(since);
    until.setHours(23, 59, 59, 999);
    return { since, until, label: "Yesterday" };
  }

  if (lower === "this-week") {
    const since = new Date(now);
    since.setDate(since.getDate() - since.getDay()); // Sunday
    since.setHours(0, 0, 0, 0);
    return { since, until: now, label: "This Week" };
  }

  if (lower === "last-week") {
    const until = new Date(now);
    until.setDate(until.getDate() - until.getDay()); // Start of this week (Sunday)
    until.setHours(0, 0, 0, 0);
    const since = new Date(until);
    since.setDate(since.getDate() - 7);
    return { since, until, label: "Last Week" };
  }

  // Range: "14d..8d" or "2026-03-10..2026-03-17"
  if (lower.includes("..")) {
    const parts = lower.split("..");
    if (parts.length === 2) {
      const since = parseTimeValue(parts[0].trim());
      const until = parseTimeValue(parts[1].trim());
      return { since, until, label: value };
    }
  }

  // Simple relative: "7d", "24h" — means "last N units to now"
  const relMatch = lower.match(/^(\d+)(d|h)$/);
  if (relMatch) {
    const since = parseTimeValue(value);
    return { since, until: now, label: `Last ${value}` };
  }

  // Fall through to ISO parsing
  const since = parseTimeValue(value);
  return { since, until: now, label: value };
}

async function loadPeriod(range: PeriodRange): Promise<{ sessions: SessionSummary[]; calls: ApiCall[] }> {
  const files = await discoverFiles({
    since: new Date(range.since.getTime() - 3600_000), // 1h margin for mtime
    until: new Date(range.until.getTime() + 3600_000),
  });

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

  // Filter calls to exact window
  const windowCalls = allCalls.filter((c) => {
    const t = new Date(c.timestamp).getTime();
    return t >= range.since.getTime() && t <= range.until.getTime();
  });

  const sessions = aggregateSessions(files, callsByFile).filter((s) => {
    const t = new Date(s.firstSeen).getTime();
    return t >= range.since.getTime() && t <= range.until.getTime();
  });

  return { sessions, calls: windowCalls };
}

function computePeriodStats(label: string, sessions: SessionSummary[], calls: ApiCall[]): PeriodStats {
  const totalTokens = sessions.reduce((sum, s) => sum + s.totalTokens, 0);
  const sessionCount = sessions.length;
  const avgSessionSize = sessionCount > 0 ? Math.round(totalTokens / sessionCount) : 0;

  // Model distribution — use call-level total as denominator so percentages sum to ~100%
  const modelDistribution = new Map<string, number>();
  const callTotal = calls.reduce((sum, c) => sum + c.totalTokens, 0);
  for (const call of calls) {
    modelDistribution.set(call.model, (modelDistribution.get(call.model) ?? 0) + call.totalTokens);
  }

  // Cache efficiency
  const totalInput = calls.reduce((sum, c) => sum + c.inputTokens + c.cacheReadTokens, 0);
  const totalCacheRead = calls.reduce((sum, c) => sum + c.cacheReadTokens, 0);
  const cacheEfficiency = totalInput > 0 ? totalCacheRead / totalInput : 0;

  // Team vs solo split
  const teamTokens = sessions.filter((s) => s.teamName).reduce((sum, s) => sum + s.totalTokens, 0);
  const soloTokens = totalTokens - teamTokens;
  const teamPercent = totalTokens > 0 ? teamTokens / totalTokens : 0;

  // Top 5 sessions
  const topSessions = [...sessions].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, 5);

  return {
    label,
    totalTokens,
    callTotal,
    sessionCount,
    avgSessionSize,
    modelDistribution,
    cacheEfficiency,
    teamTokens,
    soloTokens,
    teamPercent,
    topSessions,
  };
}

function formatDelta(a: number, b: number): string {
  if (b === 0) return a > 0 ? "+∞" : "0";
  const pct = ((a - b) / b) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

export async function runCompare(args: string[], useDb = false): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      a: { type: "string" },
      b: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  if (!values.a || !values.b) {
    console.error("Both --a and --b periods are required.\n");
    printHelp();
    process.exit(1);
  }

  const rangeA = parsePeriod(values.a);
  const rangeB = parsePeriod(values.b);

  // Load both periods
  let dataA, dataB;
  if (useDb) {
    const db = openDatabase();
    const sessionsA = querySessions(db, { since: rangeA.since, until: rangeA.until });
    const callsA = queryApiCalls(db, { since: rangeA.since, until: rangeA.until });
    const sessionsB = querySessions(db, { since: rangeB.since, until: rangeB.until });
    const callsB = queryApiCalls(db, { since: rangeB.since, until: rangeB.until });
    closeDatabase();
    dataA = { sessions: sessionsA, calls: callsA };
    dataB = { sessions: sessionsB, calls: callsB };
  } else {
    [dataA, dataB] = await Promise.all([
      loadPeriod(rangeA),
      loadPeriod(rangeB),
    ]);
  }

  const statsA = computePeriodStats(rangeA.label, dataA.sessions, dataA.calls);
  const statsB = computePeriodStats(rangeB.label, dataB.sessions, dataB.calls);

  if (values.json) {
    const jsonify = (stats: PeriodStats) => ({
      ...stats,
      modelDistribution: Object.fromEntries(stats.modelDistribution),
      topSessions: stats.topSessions.map((s) => ({
        sessionId: s.sessionId,
        projectDir: s.projectDir,
        totalTokens: s.totalTokens,
        model: s.primaryModel,
      })),
    });
    console.log(JSON.stringify({ periodA: jsonify(statsA), periodB: jsonify(statsB) }, null, 2));
    return;
  }

  console.log(`\n**Period Comparison** — ${rangeA.label} (A) vs ${rangeB.label} (B)\n`);

  // Summary comparison table
  const summaryHeaders = ["Metric", "Period A", "Period B", "Change"];
  const summaryRows = [
    ["Total Tokens", formatTokens(statsA.totalTokens), formatTokens(statsB.totalTokens), formatDelta(statsA.totalTokens, statsB.totalTokens)],
    ["Sessions", String(statsA.sessionCount), String(statsB.sessionCount), formatDelta(statsA.sessionCount, statsB.sessionCount)],
    ["Avg Session Size", formatTokens(statsA.avgSessionSize), formatTokens(statsB.avgSessionSize), formatDelta(statsA.avgSessionSize, statsB.avgSessionSize)],
    ["Cache Efficiency", formatPercent(statsA.cacheEfficiency), formatPercent(statsB.cacheEfficiency), formatDelta(statsA.cacheEfficiency, statsB.cacheEfficiency)],
    ["Team %", formatPercent(statsA.teamPercent), formatPercent(statsB.teamPercent), formatDelta(statsA.teamPercent, statsB.teamPercent)],
  ];

  console.log(markdownTable(summaryHeaders, summaryRows));

  // Model distribution comparison
  const allModels = new Set([...statsA.modelDistribution.keys(), ...statsB.modelDistribution.keys()]);
  if (allModels.size > 0) {
    console.log(`\n**Model Distribution**\n`);

    const modelHeaders = ["Model", "Period A", "% A", "Period B", "% B", "Shift"];
    const modelRows = Array.from(allModels)
      .map((model) => {
        const tokensA = statsA.modelDistribution.get(model) ?? 0;
        const tokensB = statsB.modelDistribution.get(model) ?? 0;
        const pctA = statsA.callTotal > 0 ? tokensA / statsA.callTotal : 0;
        const pctB = statsB.callTotal > 0 ? tokensB / statsB.callTotal : 0;
        return {
          model,
          tokensA,
          tokensB,
          pctA,
          pctB,
        };
      })
      .sort((a, b) => b.tokensA - a.tokensA)
      .map((m) => [
        m.model.replace("claude-", ""),
        formatTokens(m.tokensA),
        formatPercent(m.pctA),
        formatTokens(m.tokensB),
        formatPercent(m.pctB),
        formatDelta(m.tokensA, m.tokensB),
      ]);

    console.log(markdownTable(modelHeaders, modelRows));
  }

  // Top 5 sessions per period
  for (const [label, stats] of [["A", statsA], ["B", statsB]] as const) {
    if (stats.topSessions.length > 0) {
      console.log(`\n**Top 5 Sessions — Period ${label}** (${stats.label})\n`);

      const topHeaders = ["#", "Session", "Project", "Tokens", "Model", "Team"];
      const topRows = stats.topSessions.map((s, i) => [
        String(i + 1),
        truncateSessionId(s.sessionId),
        formatProjectDir(s.projectDir),
        formatTokens(s.totalTokens),
        s.primaryModel.replace("claude-", ""),
        s.teamName ?? "solo",
      ]);

      console.log(markdownTable(topHeaders, topRows));
    }
  }
}

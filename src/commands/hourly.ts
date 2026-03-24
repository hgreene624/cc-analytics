import { parseArgs } from "node:util";
import { discoverFiles } from "../discovery.js";
import { parseSessionFile } from "../parser.js";
import { parseTimeValue } from "../time.js";
import { formatTokens } from "../formatter.js";
import { openDatabase, closeDatabase } from "../db/connection.js";
import { queryApiCalls } from "../db/queries.js";
import type { ApiCall } from "../parser.js";

function printHelp(): void {
  console.log(`
cc-analytics hourly — Hour-by-hour token consumption chart

Usage:
  cc-analytics hourly [options]

Options:
  --date <value>    Date to chart (ISO date, or: today/yesterday). Default: today
  --metric <value>  Which metric to chart: rate_limit | total | both (default: both)
  --json            Output as JSON instead of chart
  --help, -h        Show this help message

Examples:
  cc-analytics hourly
  cc-analytics hourly --date yesterday
  cc-analytics hourly --date 2026-03-20
  cc-analytics hourly --metric rate_limit
  cc-analytics hourly --json
`);
}

interface HourBucket {
  hour: number;
  totalTokens: number;
  rateLimitTokens: number;
  apiCalls: number;
  sessions: Set<string>;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return n.toString();
}

function bar(val: number, max: number, width: number): string {
  if (max === 0 || val === 0) return "";
  const len = Math.round((val / max) * width);
  return "█".repeat(Math.max(len, 0));
}

function resolveDate(dateStr: string): Date {
  const d = new Date();
  if (dateStr === "today") {
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (dateStr === "yesterday") {
    d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  // Try ISO date
  const parsed = new Date(dateStr + "T00:00:00");
  if (!isNaN(parsed.getTime())) return parsed;
  // Fallback to today
  d.setHours(0, 0, 0, 0);
  return d;
}

export async function runHourly(args: string[], useDb = false): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      date: { type: "string", default: "today" },
      metric: { type: "string", default: "both" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  const dayStart = resolveDate(values.date!);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const isToday = dayStart.toDateString() === new Date().toDateString();

  let allCalls: ApiCall[];

  if (useDb) {
    const db = openDatabase();
    allCalls = queryApiCalls(db, { since: dayStart, until: dayEnd });
    closeDatabase();
  } else {
    const files = await discoverFiles({ since: dayStart, until: dayEnd });
    if (files.length === 0) {
      console.log("No JSONL files found for " + dayStart.toISOString().slice(0, 10) + ".");
      return;
    }
    allCalls = [];
    for (const file of files) {
      try {
        const calls = await parseSessionFile(file.path);
        allCalls.push(...calls);
      } catch { /* skip malformed */ }
    }
  }

  // Bucket by hour
  const buckets: HourBucket[] = Array.from({ length: 24 }, (_, i) => ({
    hour: i,
    totalTokens: 0,
    rateLimitTokens: 0,
    apiCalls: 0,
    sessions: new Set<string>(),
  }));

  for (const call of allCalls) {
    const d = new Date(call.timestamp);
    if (d < dayStart || d >= dayEnd) continue;
    const h = d.getHours();
    buckets[h].totalTokens += call.totalTokens;
    buckets[h].rateLimitTokens += call.rateLimitTokens;
    buckets[h].apiCalls += 1;
    buckets[h].sessions.add(call.sessionId);
  }

  // Determine display range
  const lastHour = isToday ? new Date().getHours() : 23;
  const activeBuckets = buckets.filter((b, i) => i <= lastHour);
  const firstActive = activeBuckets.findIndex((b) => b.totalTokens > 0 || b.rateLimitTokens > 0);
  const startHour = Math.max(0, firstActive);

  const displayBuckets = activeBuckets.slice(startHour);

  if (displayBuckets.length === 0 || displayBuckets.every((b) => b.totalTokens === 0)) {
    console.log("No activity found for " + dayStart.toISOString().slice(0, 10) + ".");
    return;
  }

  // Compute totals
  const totalRL = displayBuckets.reduce((s, b) => s + b.rateLimitTokens, 0);
  const totalAll = displayBuckets.reduce((s, b) => s + b.totalTokens, 0);
  const totalCalls = displayBuckets.reduce((s, b) => s + b.apiCalls, 0);
  const maxRL = Math.max(...displayBuckets.map((b) => b.rateLimitTokens));
  const maxTotal = Math.max(...displayBuckets.map((b) => b.totalTokens));
  const peakRLHour = displayBuckets.reduce((best, b) => b.rateLimitTokens > best.rateLimitTokens ? b : best);
  const peakTotalHour = displayBuckets.reduce((best, b) => b.totalTokens > best.totalTokens ? b : best);

  const dateLabel = dayStart.toISOString().slice(0, 10);

  if (values.json) {
    console.log(JSON.stringify({
      date: dateLabel,
      hours: displayBuckets.map((b) => ({
        hour: b.hour,
        totalTokens: b.totalTokens,
        rateLimitTokens: b.rateLimitTokens,
        apiCalls: b.apiCalls,
        sessions: b.sessions.size,
      })),
      summary: {
        totalTokens: totalAll,
        rateLimitTokens: totalRL,
        apiCalls: totalCalls,
        peakRateLimitHour: peakRLHour.hour,
        peakRateLimitTokens: peakRLHour.rateLimitTokens,
        peakTotalHour: peakTotalHour.hour,
        peakTotalTokens: peakTotalHour.totalTokens,
      },
    }, null, 2));
    return;
  }

  const chartWidth = 50;

  console.log(`\n# Hourly Token Consumption — ${dateLabel}`);

  const showRL = values.metric === "rate_limit" || values.metric === "both";
  const showTotal = values.metric === "total" || values.metric === "both";

  if (showRL) {
    console.log(`\n## Rate-Limit Tokens (counts against quota)\n`);
    for (const b of displayBuckets) {
      const label = String(b.hour).padStart(2, "0") + ":00";
      const chart = bar(b.rateLimitTokens, maxRL, chartWidth);
      console.log(`${label} │ ${chart.padEnd(chartWidth)} ${fmt(b.rateLimitTokens).padStart(6)}`);
    }
    console.log(`\nPeak: ${String(peakRLHour.hour).padStart(2, "0")}:00 (${fmt(peakRLHour.rateLimitTokens)})  •  Total: ${fmt(totalRL)}`);
  }

  if (showTotal) {
    console.log(`\n## Total Tokens (including cache reads)\n`);
    for (const b of displayBuckets) {
      const label = String(b.hour).padStart(2, "0") + ":00";
      const chart = bar(b.totalTokens, maxTotal, chartWidth);
      console.log(`${label} │ ${chart.padEnd(chartWidth)} ${fmt(b.totalTokens).padStart(6)}`);
    }
    console.log(`\nPeak: ${String(peakTotalHour.hour).padStart(2, "0")}:00 (${fmt(peakTotalHour.totalTokens)})  •  Total: ${fmt(totalAll)}`);
  }

  // Summary footer
  const activeHours = displayBuckets.filter((b) => b.rateLimitTokens > 0).length;
  const avgRLPerHour = activeHours > 0 ? Math.round(totalRL / activeHours) : 0;
  console.log(`\n---`);
  console.log(`**${activeHours} active hours** • ${fmt(avgRLPerHour)} avg rate-limit tokens/hr • ${totalCalls.toLocaleString()} API calls`);
  console.log(``);
}

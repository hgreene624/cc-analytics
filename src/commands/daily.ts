import { parseArgs } from "node:util";
import { discoverFiles } from "../discovery.js";
import { parseSessionFile } from "../parser.js";
import { openDatabase, closeDatabase } from "../db/connection.js";
import { queryApiCalls } from "../db/queries.js";
import type { ApiCall } from "../parser.js";

function printHelp(): void {
  console.log(`
cc-analytics daily — Rolling window usage throughout the day

Usage:
  cc-analytics daily [options]

Shows rate-limit token consumption in rolling 5-hour windows across the day,
matching Claude's plan usage limit meter. Each row shows the cumulative
rate-limit tokens in the 5 hours ending at that time.

Options:
  --date <value>      Date to chart (ISO date, or: today/yesterday). Default: today
  --window <minutes>  Rolling window size in minutes (default: 300 = 5 hours)
  --step <minutes>    Time step between rows in minutes (default: 15)
  --ceiling <tokens>  Estimated token ceiling for % calculation (default: 14300000)
  --json              Output as JSON instead of chart
  --help, -h          Show this help message

Examples:
  cc-analytics daily
  cc-analytics daily --date yesterday
  cc-analytics daily --step 30
  cc-analytics daily --ceiling 15000000
`);
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

function timeLabel(d: Date): string {
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
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
  const parsed = new Date(dateStr + "T00:00:00");
  if (!isNaN(parsed.getTime())) return parsed;
  d.setHours(0, 0, 0, 0);
  return d;
}

interface WindowRow {
  time: Date;
  rateLimitTokens: number;
  pctOfCeiling: number;
}

export async function runDaily(args: string[], useDb = false): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      date: { type: "string", default: "today" },
      window: { type: "string", default: "300" },
      step: { type: "string", default: "15" },
      ceiling: { type: "string", default: "14300000" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  const windowMinutes = parseInt(values.window!, 10) || 300;
  const stepMinutes = parseInt(values.step!, 10) || 15;
  const ceiling = parseInt(values.ceiling!, 10) || 14_300_000;
  const windowMs = windowMinutes * 60 * 1000;

  const dayStart = resolveDate(values.date!);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const isToday = dayStart.toDateString() === new Date().toDateString();
  const dateLabel = dayStart.toISOString().slice(0, 10);

  // Need data from window-size before the day starts
  const fetchStart = new Date(dayStart.getTime() - windowMs);

  let allCalls: ApiCall[];

  if (useDb) {
    const db = openDatabase();
    allCalls = queryApiCalls(db, { since: fetchStart, until: dayEnd });
    closeDatabase();
  } else {
    const files = await discoverFiles({ since: fetchStart, until: dayEnd });
    if (files.length === 0) {
      console.log("No sessions found for " + dateLabel + ".");
      return;
    }
    allCalls = [];
    for (const file of files) {
      try {
        const calls = await parseSessionFile(file.path);
        allCalls.push(...calls);
      } catch { /* skip */ }
    }
  }

  // Sort calls by timestamp
  const sortedCalls = allCalls
    .filter((c) => c.rateLimitTokens > 0)
    .map((c) => ({ ts: new Date(c.timestamp).getTime(), rl: c.rateLimitTokens }))
    .sort((a, b) => a.ts - b.ts);

  if (sortedCalls.length === 0) {
    console.log("No rate-limit token activity found for " + dateLabel + ".");
    return;
  }

  // Compute rolling window at each step
  const rows: WindowRow[] = [];
  const endTime = isToday ? new Date() : dayEnd;

  for (let t = dayStart.getTime(); t <= endTime.getTime(); t += stepMinutes * 60 * 1000) {
    const windowStart = t - windowMs;
    let sum = 0;
    for (const call of sortedCalls) {
      if (call.ts > windowStart && call.ts <= t) {
        sum += call.rl;
      }
    }
    rows.push({
      time: new Date(t),
      rateLimitTokens: sum,
      pctOfCeiling: (sum / ceiling) * 100,
    });
  }

  // Trim leading zeros
  const firstNonZero = rows.findIndex((r) => r.rateLimitTokens > 0);
  const startIdx = Math.max(0, firstNonZero - 1); // one row before first activity
  const displayRows = rows.slice(startIdx);

  if (displayRows.length === 0) {
    console.log("No activity found for " + dateLabel + ".");
    return;
  }

  if (values.json) {
    console.log(JSON.stringify({
      date: dateLabel,
      windowMinutes,
      stepMinutes,
      ceiling,
      rows: displayRows.map((r) => ({
        time: r.time.toISOString(),
        rateLimitTokens: r.rateLimitTokens,
        pctOfCeiling: Math.round(r.pctOfCeiling * 10) / 10,
      })),
    }, null, 2));
    return;
  }

  const chartWidth = 40;
  const windowHours = windowMinutes / 60;
  const peakRow = displayRows.reduce((best, r) => r.rateLimitTokens > best.rateLimitTokens ? r : best);

  console.log(`\n# Rolling ${windowHours}h Window — ${dateLabel} (Rate-Limit Tokens)\n`);
  console.log(`Ceiling estimate: ${fmt(ceiling)} • Each row = cumulative RL tokens in prior ${windowHours}h\n`);

  // Use ceiling as the max for the bar chart so the bar shows % of limit
  const barMax = Math.max(ceiling, peakRow.rateLimitTokens);

  for (const r of displayRows) {
    const time = timeLabel(r.time);
    const pct = r.pctOfCeiling;
    const chart = bar(r.rateLimitTokens, barMax, chartWidth);

    // Color-code the percentage marker
    let marker = "";
    if (pct >= 80) marker = " !!";
    else if (pct >= 60) marker = " !";

    console.log(`${time} │ ${chart.padEnd(chartWidth)} ${fmt(r.rateLimitTokens).padStart(6)} ${(pct.toFixed(0) + "%").padStart(4)}${marker}`);
  }

  console.log(`     └${"─".repeat(chartWidth + 16)}`);

  // Summary
  console.log(`\nPeak: ${timeLabel(peakRow.time)} at ${fmt(peakRow.rateLimitTokens)} (${peakRow.pctOfCeiling.toFixed(0)}% of ceiling)`);

  // Find when ceiling was closest to being hit
  const dangerRows = displayRows.filter((r) => r.pctOfCeiling >= 60);
  if (dangerRows.length > 0) {
    const dangerStart = timeLabel(dangerRows[0].time);
    const dangerEnd = timeLabel(dangerRows[dangerRows.length - 1].time);
    console.log(`Elevated (>60%): ${dangerStart}–${dangerEnd} (${dangerRows.length * stepMinutes} minutes)`);
  }

  console.log(``);
}

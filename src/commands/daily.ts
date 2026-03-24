import { parseArgs } from "node:util";
import { discoverFiles } from "../discovery.js";
import { parseSessionFile } from "../parser.js";
import { openDatabase, closeDatabase } from "../db/connection.js";
import { queryApiCalls } from "../db/queries.js";
import type { ApiCall } from "../parser.js";

function printHelp(): void {
  console.log(`
cc-analytics daily — Rate of token consumption throughout the day

Usage:
  cc-analytics daily [options]

Shows rate-limit tokens consumed per time interval across the day.
Each row is the tokens spent in that interval — not cumulative.

Options:
  --date <value>      Date to chart (ISO date, or: today/yesterday). Default: today
  --step <minutes>    Time interval in minutes (default: 15)
  --json              Output as JSON instead of chart
  --help, -h          Show this help message

Examples:
  cc-analytics daily
  cc-analytics daily --date yesterday
  cc-analytics daily --step 30
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

export async function runDaily(args: string[], useDb = false): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      date: { type: "string", default: "today" },
      step: { type: "string", default: "15" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  const stepMinutes = parseInt(values.step!, 10) || 15;

  const dayStart = resolveDate(values.date!);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);
  const isToday = dayStart.toDateString() === new Date().toDateString();
  const dateLabel = dayStart.toISOString().slice(0, 10);

  const fetchStart = dayStart;

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

  // Bucket calls into time intervals
  const stepMs = stepMinutes * 60 * 1000;
  const endTime = isToday ? new Date() : dayEnd;
  const buckets: { time: Date; rateLimitTokens: number }[] = [];

  for (let t = dayStart.getTime(); t < endTime.getTime(); t += stepMs) {
    const bucketEnd = t + stepMs;
    let sum = 0;
    for (const call of sortedCalls) {
      if (call.ts >= t && call.ts < bucketEnd) {
        sum += call.rl;
      }
    }
    buckets.push({ time: new Date(t), rateLimitTokens: sum });
  }

  // Trim leading and trailing zeros
  const firstNonZero = buckets.findIndex((b) => b.rateLimitTokens > 0);
  const lastNonZero = buckets.findLastIndex((b) => b.rateLimitTokens > 0);
  if (firstNonZero === -1) {
    console.log("No activity found for " + dateLabel + ".");
    return;
  }
  const startIdx = Math.max(0, firstNonZero - 1);
  const endIdx = Math.min(buckets.length - 1, lastNonZero + 1);
  const displayRows = buckets.slice(startIdx, endIdx + 1);

  const totalRL = displayRows.reduce((s, b) => s + b.rateLimitTokens, 0);
  const maxRL = Math.max(...displayRows.map((b) => b.rateLimitTokens));
  const peakRow = displayRows.reduce((best, b) => b.rateLimitTokens > best.rateLimitTokens ? b : best);
  const activeIntervals = displayRows.filter((b) => b.rateLimitTokens > 0).length;

  if (values.json) {
    console.log(JSON.stringify({
      date: dateLabel,
      stepMinutes,
      buckets: displayRows.map((b) => ({
        time: b.time.toISOString(),
        rateLimitTokens: b.rateLimitTokens,
      })),
      summary: { totalRateLimitTokens: totalRL, peakInterval: peakRow.time.toISOString(), peakTokens: peakRow.rateLimitTokens },
    }, null, 2));
    return;
  }

  const chartWidth = 45;
  const windowHours = 5;
  const windowMs2 = windowHours * 60 * 60 * 1000;

  // Determine session window boundaries
  // Find the first activity timestamp to anchor windows
  const firstActivityTs = sortedCalls[0].ts;
  const windowAnchor = firstActivityTs - (firstActivityTs % (60 * 60 * 1000)); // round down to hour

  // Assign each bucket to a session window
  const barChars = ["█", "▓"];
  let windowNum = 0;
  let windowEnd = windowAnchor + windowMs2;

  // Pre-compute window assignments and totals
  const windowTotals: { start: Date; end: Date; total: number; num: number }[] = [];
  const bucketWindows: number[] = [];

  for (const b of displayRows) {
    const t = b.time.getTime();
    // Advance windows as needed
    while (t >= windowEnd) {
      windowEnd += windowMs2;
      windowNum++;
    }
    bucketWindows.push(windowNum);

    // Track window totals
    const wIdx = windowNum;
    while (windowTotals.length <= wIdx) {
      const wStart = new Date(windowAnchor + windowTotals.length * windowMs2);
      const wEnd = new Date(wStart.getTime() + windowMs2);
      windowTotals.push({ start: wStart, end: wEnd, total: 0, num: windowTotals.length });
    }
    windowTotals[wIdx].total += b.rateLimitTokens;
  }

  const stepLabel = stepMinutes >= 60 ? `${stepMinutes / 60}hr` : `${stepMinutes}min`;
  console.log(`\n# Rate of Usage — ${dateLabel} (Rate-Limit Tokens per ${stepLabel})\n`);

  let lastWindowNum = -1;
  const sepWidth = 6 + 3 + chartWidth + 8;

  for (let i = 0; i < displayRows.length; i++) {
    const b = displayRows[i];
    const wNum = bucketWindows[i];

    // Print session window separator
    if (wNum !== lastWindowNum) {
      if (lastWindowNum >= 0) {
        console.log(`      ${"╌".repeat(sepWidth - 6)} window ${lastWindowNum + 1}: ${fmt(windowTotals[lastWindowNum].total)}`);
        console.log(``);
      }
      lastWindowNum = wNum;
    }

    const time = timeLabel(b.time);
    const charIdx = wNum % barChars.length;
    const chart = barChars[charIdx].repeat(Math.max(0, Math.round((b.rateLimitTokens / maxRL) * chartWidth)));
    console.log(`${time}  ${chart.padEnd(chartWidth)} ${fmt(b.rateLimitTokens).padStart(6)}`);
  }

  // Final window separator
  if (lastWindowNum >= 0) {
    console.log(`      ${"╌".repeat(sepWidth - 6)} window ${lastWindowNum + 1}: ${fmt(windowTotals[lastWindowNum].total)}`);
  }

  console.log(``);

  const avgPerInterval = activeIntervals > 0 ? Math.round(totalRL / activeIntervals) : 0;
  console.log(`\nPeak: ${timeLabel(peakRow.time)} (${fmt(peakRow.rateLimitTokens)}/${stepLabel}) • Total: ${fmt(totalRL)} • Avg active: ${fmt(avgPerInterval)}/${stepLabel}`);

  // Window summary
  const activeWindows = windowTotals.filter((w) => w.total > 0);
  if (activeWindows.length > 0) {
    console.log(`\nSession windows (${windowHours}h each):\n`);
    for (const w of activeWindows) {
      const pct = ((w.total / 14_300_000) * 100).toFixed(0);
      console.log(`  Window ${w.num + 1}: ${timeLabel(w.start)}–${timeLabel(w.end)} │ ${fmt(w.total).padStart(6)} (${pct}% of est. ceiling)`);
    }
  }

  console.log(``);
}

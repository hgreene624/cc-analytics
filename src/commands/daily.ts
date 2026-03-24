import { parseArgs } from "node:util";
import { discoverFiles } from "../discovery.js";
import { parseSessionFile } from "../parser.js";
import { parseTimeValue } from "../time.js";
import { openDatabase, closeDatabase } from "../db/connection.js";
import { queryApiCalls } from "../db/queries.js";
import type { ApiCall } from "../parser.js";

function printHelp(): void {
  console.log(`
cc-analytics daily — Full-day session breakdown (rate-limit tokens)

Usage:
  cc-analytics daily [options]

Options:
  --date <value>    Date to chart (ISO date, or: today/yesterday). Default: today
  --json            Output as JSON instead of chart
  --help, -h        Show this help message

Shows every session in chronological order with rate-limit token consumption.
Time on Y axis, rate-limit tokens on X axis, segmented by session.

Examples:
  cc-analytics daily
  cc-analytics daily --date yesterday
  cc-analytics daily --date 2026-03-20
`);
}

interface SessionRow {
  sessionId: string;
  shortId: string;
  team: string;
  startTime: Date;
  endTime: Date;
  rateLimitTokens: number;
  apiCalls: number;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return n.toString();
}

function timeLabel(d: Date): string {
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function bar(val: number, max: number, width: number): string {
  if (max === 0 || val === 0) return "";
  const len = Math.round((val / max) * width);
  return "█".repeat(Math.max(len, 1));
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
  const dateLabel = dayStart.toISOString().slice(0, 10);

  let allCalls: ApiCall[];

  if (useDb) {
    const db = openDatabase();
    allCalls = queryApiCalls(db, { since: dayStart, until: dayEnd });
    closeDatabase();
  } else {
    const files = await discoverFiles({ since: dayStart, until: dayEnd });
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

  // Filter to this day only
  const dayCalls = allCalls.filter((c) => {
    const d = new Date(c.timestamp);
    return d >= dayStart && d < dayEnd;
  });

  if (dayCalls.length === 0) {
    console.log("No activity found for " + dateLabel + ".");
    return;
  }

  // Group by session
  const sessionMap = new Map<string, {
    calls: ApiCall[];
    team: string;
  }>();

  for (const call of dayCalls) {
    if (!sessionMap.has(call.sessionId)) {
      sessionMap.set(call.sessionId, { calls: [], team: call.teamName || "" });
    }
    const entry = sessionMap.get(call.sessionId)!;
    entry.calls.push(call);
    // Prefer non-empty team name
    if (call.teamName && !entry.team) entry.team = call.teamName;
  }

  // Build session rows
  const rows: SessionRow[] = [];
  for (const [sid, data] of sessionMap) {
    const timestamps = data.calls.map((c) => new Date(c.timestamp).getTime());
    const rl = data.calls.reduce((s, c) => s + c.rateLimitTokens, 0);
    if (rl === 0) continue; // skip zero-contribution sessions

    rows.push({
      sessionId: sid,
      shortId: sid.slice(0, 8),
      team: data.team || "-",
      startTime: new Date(Math.min(...timestamps)),
      endTime: new Date(Math.max(...timestamps)),
      rateLimitTokens: rl,
      apiCalls: data.calls.length,
    });
  }

  // Sort by start time
  rows.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  if (rows.length === 0) {
    console.log("No sessions with rate-limit tokens found for " + dateLabel + ".");
    return;
  }

  const totalRL = rows.reduce((s, r) => s + r.rateLimitTokens, 0);
  const maxRL = Math.max(...rows.map((r) => r.rateLimitTokens));

  if (values.json) {
    console.log(JSON.stringify({
      date: dateLabel,
      sessions: rows.map((r) => ({
        sessionId: r.sessionId,
        team: r.team,
        start: r.startTime.toISOString(),
        end: r.endTime.toISOString(),
        rateLimitTokens: r.rateLimitTokens,
        apiCalls: r.apiCalls,
      })),
      summary: {
        totalRateLimitTokens: totalRL,
        sessionCount: rows.length,
        peakSession: rows.reduce((best, r) => r.rateLimitTokens > best.rateLimitTokens ? r : best).sessionId,
      },
    }, null, 2));
    return;
  }

  const chartWidth = 35;

  // Compute longest label for alignment
  const teamMaxLen = Math.min(20, Math.max(...rows.map((r) => r.team.length)));

  console.log(`\n# Daily Session Breakdown — ${dateLabel} (Rate-Limit Tokens)\n`);

  for (const r of rows) {
    const time = timeLabel(r.startTime);
    const team = r.team.length > 20 ? r.team.slice(0, 19) + "…" : r.team.padEnd(teamMaxLen);
    const chart = bar(r.rateLimitTokens, maxRL, chartWidth);
    const pct = ((r.rateLimitTokens / totalRL) * 100).toFixed(1);
    console.log(`${time} ${r.shortId} ${team} │ ${chart.padEnd(chartWidth)} ${fmt(r.rateLimitTokens).padStart(6)} (${pct.padStart(4)}%)`);
  }

  console.log(`${"".padEnd(8 + 1 + 8 + 1 + teamMaxLen)} └${"─".repeat(chartWidth + 16)}`);
  console.log(`\n**${rows.length} sessions** • ${fmt(totalRL)} total rate-limit tokens • Peak: ${rows.reduce((best, r) => r.rateLimitTokens > best.rateLimitTokens ? r : best).shortId} (${fmt(maxRL)})`);
  console.log(``);
}

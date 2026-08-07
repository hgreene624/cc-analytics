import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { formatTokens, markdownTable } from "../formatter.js";

const TRACKING_FILE = join(homedir(), ".cc-analytics", "usage-tracking.jsonl");

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function printHelp(): void {
  console.log(`
cc-analytics windows — Window-level ceiling analysis

Usage:
  cc-analytics windows [options]

Aggregates 5-minute tracking snapshots into one row per rate-limit
window. Shows ceiling generosity (NC/1%), peak usage, time-of-day
patterns, and trends over time.

Each row represents one 5-hour rate-limit window with:
  - Start time and day of week
  - Peak percentage reached
  - Median and mean NC/1% (non-cache tokens per 1% meter movement)
  - Implied ceiling (median NC/1% * 100)
  - Total non-cache tokens consumed
  - Number of active sessions

Options:
  --days <n>        Days of history (default: 7)
  --since <date>    Start date (YYYY-MM-DD), overrides --days
  --json            Output as JSON for piping into reports
  --verbose         Show per-window interval breakdown
  --help, -h        Show this help message

Examples:
  cc-analytics windows                     # Last 7 days
  cc-analytics windows --days 30           # Last 30 days
  cc-analytics windows --since 2026-03-24  # Since tracking began
  cc-analytics windows --json              # JSON for report generation
  cc-analytics windows --verbose           # Include interval detail
`);
}

interface TrackingSnapshot {
  timestamp: string;
  session_pct: number | null;
  weekly_pct: number | null;
  session_resets_at: string | null;
  weekly_resets_at: string | null;
  stale: boolean;
  data_stale: boolean;
  interval: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    total_tokens: number;
    non_cache_tokens: number;
    api_calls: number;
    sessions: number;
  };
  delta_pct: number | null;
}

interface WindowSummary {
  window_id: string;
  resets_at: string;
  start_time: string;
  day_of_week: string;
  start_hour: number;
  peak_pct: number;
  final_pct: number;
  snapshots: number;
  active_snapshots: number;
  total_nc_tokens: number;
  total_tokens: number;
  total_cache_read: number;
  total_cache_create: number;
  total_api_calls: number;
  max_concurrent_sessions: number;
  cache_efficiency_pct: number;
  nc_per_pct_median: number | null;
  nc_per_pct_mean: number | null;
  nc_per_pct_min: number | null;
  nc_per_pct_max: number | null;
  nc_per_pct_samples: number;
  implied_ceiling: number | null;
  intervals: Array<{
    time: string;
    pct: number | null;
    delta_pct: number | null;
    nc_tokens: number;
    api_calls: number;
    sessions: number;
    nc_per_pct: number | null;
  }>;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0")
  );
}

function dateLabel(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return n.toString();
}

async function loadSnapshots(since: Date): Promise<TrackingSnapshot[]> {
  let raw: string;
  try {
    raw = await readFile(TRACKING_FILE, "utf-8");
  } catch {
    return [];
  }

  const lines = raw.trim().split("\n").filter(Boolean);
  const snapshots: TrackingSnapshot[] = [];

  for (const line of lines) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (new Date(row.timestamp as string) < since) continue;

      // Normalize v1 format
      if (!row.interval && row.total_tokens != null) {
        row.interval = {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          total_tokens: row.total_tokens as number,
          non_cache_tokens: 0,
          api_calls: row.api_calls as number,
          sessions: row.active_sessions as number,
        };
      }

      const interval = row.interval as Record<string, unknown> | undefined;
      if (interval && interval.non_cache_tokens == null) {
        interval.non_cache_tokens =
          ((interval.input_tokens as number) ?? 0) +
          ((interval.output_tokens as number) ?? 0) +
          ((interval.cache_creation_tokens as number) ?? 0);
      }

      snapshots.push(row as unknown as TrackingSnapshot);
    } catch {
      /* skip malformed */
    }
  }

  return snapshots;
}

function buildWindows(snapshots: TrackingSnapshot[]): WindowSummary[] {
  // Group by window (session_resets_at)
  const windowGroups = new Map<string, TrackingSnapshot[]>();
  for (const s of snapshots) {
    const key = s.session_resets_at ?? "unknown";
    if (!windowGroups.has(key)) windowGroups.set(key, []);
    windowGroups.get(key)!.push(s);
  }

  const windows: WindowSummary[] = [];

  for (const [resetKey, wSnaps] of windowGroups) {
    if (resetKey === "unknown") continue;

    const resetMs = new Date(resetKey).getTime();
    const windowStartMs = resetMs - 5 * 60 * 60 * 1000;
    const startDate = new Date(windowStartMs);

    // Filter out stale-only windows (no real activity)
    const activeSnaps = wSnaps.filter((s) => !s.stale && !s.data_stale);
    if (activeSnaps.length === 0) continue;

    // Aggregate totals
    let totalNc = 0;
    let totalTokens = 0;
    let totalCacheRead = 0;
    let totalCacheCreate = 0;
    let totalCalls = 0;
    let maxSessions = 0;
    let peakPct = 0;
    let finalPct = 0;

    // Compute NC/1% for each delta tick, accumulating flat intervals
    const ncPerPctValues: number[] = [];
    let accumulatedNc = 0;
    let accumulatedTokens = 0;

    const intervals: WindowSummary["intervals"] = [];

    for (const s of wSnaps) {
      const nc = s.interval?.non_cache_tokens ?? 0;
      const tokens = s.interval?.total_tokens ?? 0;
      const calls = s.interval?.api_calls ?? 0;
      const sessions = s.interval?.sessions ?? 0;
      const cacheRead = s.interval?.cache_read_tokens ?? 0;
      const cacheCreate = s.interval?.cache_creation_tokens ?? 0;

      if (!s.stale) {
        totalNc += nc;
        totalTokens += tokens;
        totalCacheRead += cacheRead;
        totalCacheCreate += cacheCreate;
        totalCalls += calls;
        if (sessions > maxSessions) maxSessions = sessions;
        if (s.session_pct != null && s.session_pct > peakPct) peakPct = s.session_pct;
        if (s.session_pct != null) finalPct = s.session_pct;
      }

      accumulatedNc += nc;
      accumulatedTokens += tokens;

      let ncPerPct: number | null = null;
      if (s.delta_pct != null && s.delta_pct > 0 && accumulatedNc > 0) {
        const rounded = Math.round(s.delta_pct);
        if (rounded > 0) {
          ncPerPct = Math.round(accumulatedNc / rounded);
          ncPerPctValues.push(ncPerPct);
          accumulatedNc = 0;
          accumulatedTokens = 0;
        }
      }

      intervals.push({
        time: s.timestamp,
        pct: s.session_pct,
        delta_pct: s.delta_pct,
        nc_tokens: nc,
        api_calls: calls,
        sessions,
        nc_per_pct: ncPerPct,
      });
    }

    const cacheEff =
      totalTokens > 0 ? (totalCacheRead / totalTokens) * 100 : 0;

    windows.push({
      window_id: resetKey,
      resets_at: resetKey,
      start_time: startDate.toISOString(),
      day_of_week: DAY_NAMES[startDate.getDay()],
      start_hour: startDate.getHours(),
      peak_pct: Math.round(peakPct),
      final_pct: Math.round(finalPct),
      snapshots: wSnaps.length,
      active_snapshots: activeSnaps.length,
      total_nc_tokens: totalNc,
      total_tokens: totalTokens,
      total_cache_read: totalCacheRead,
      total_cache_create: totalCacheCreate,
      total_api_calls: totalCalls,
      max_concurrent_sessions: maxSessions,
      cache_efficiency_pct: Math.round(cacheEff * 10) / 10,
      nc_per_pct_median: ncPerPctValues.length > 0 ? median(ncPerPctValues) : null,
      nc_per_pct_mean: ncPerPctValues.length > 0 ? mean(ncPerPctValues) : null,
      nc_per_pct_min: ncPerPctValues.length > 0 ? Math.min(...ncPerPctValues) : null,
      nc_per_pct_max: ncPerPctValues.length > 0 ? Math.max(...ncPerPctValues) : null,
      nc_per_pct_samples: ncPerPctValues.length,
      implied_ceiling:
        ncPerPctValues.length > 0 ? median(ncPerPctValues) * 100 : null,
      intervals,
    });
  }

  // Sort by start time
  windows.sort((a, b) => a.start_time.localeCompare(b.start_time));
  return windows;
}

function printSummaryStats(windows: WindowSummary[]): void {
  const withCeiling = windows.filter((w) => w.implied_ceiling != null);
  if (withCeiling.length === 0) {
    console.log("  No windows with enough data for ceiling analysis.\n");
    return;
  }

  const ceilings = withCeiling.map((w) => w.implied_ceiling!);
  const ncPerPcts = withCeiling.map((w) => w.nc_per_pct_median!);

  console.log("  Summary Statistics");
  console.log("  " + "-".repeat(50));
  console.log(`  Windows analyzed:    ${withCeiling.length}`);
  console.log(
    `  NC/1% range:         ${fmt(Math.min(...ncPerPcts))} - ${fmt(Math.max(...ncPerPcts))}`,
  );
  console.log(`  NC/1% median:        ${fmt(median(ncPerPcts))}`);
  console.log(
    `  Ceiling range:       ${fmt(Math.min(...ceilings))} - ${fmt(Math.max(...ceilings))}`,
  );
  console.log(`  Ceiling median:      ${fmt(median(ceilings))}`);
  console.log(
    `  Variance:            ${(Math.max(...ncPerPcts) / Math.min(...ncPerPcts)).toFixed(1)}x between worst and best`,
  );

  // Day-of-week breakdown
  const byDay = new Map<string, number[]>();
  for (const w of withCeiling) {
    if (!byDay.has(w.day_of_week)) byDay.set(w.day_of_week, []);
    byDay.get(w.day_of_week)!.push(w.nc_per_pct_median!);
  }

  if (byDay.size > 1) {
    console.log("");
    console.log("  By Day of Week");
    console.log("  " + "-".repeat(50));
    for (const day of DAY_NAMES) {
      const vals = byDay.get(day);
      if (!vals || vals.length === 0) continue;
      const med = median(vals);
      const bar = "=".repeat(Math.min(40, Math.round((med / Math.max(...ncPerPcts)) * 40)));
      console.log(
        `  ${day}  ${fmt(med).padStart(6)} NC/1%  (n=${vals.length})  ${bar}`,
      );
    }
  }

  // Hour-of-day breakdown
  const byHour = new Map<number, number[]>();
  for (const w of withCeiling) {
    if (!byHour.has(w.start_hour)) byHour.set(w.start_hour, []);
    byHour.get(w.start_hour)!.push(w.nc_per_pct_median!);
  }

  if (byHour.size > 1) {
    const sortedHours = [...byHour.keys()].sort((a, b) => a - b);
    console.log("");
    console.log("  By Start Hour (local)");
    console.log("  " + "-".repeat(50));
    for (const hour of sortedHours) {
      const vals = byHour.get(hour)!;
      const med = median(vals);
      const bar = "=".repeat(Math.min(40, Math.round((med / Math.max(...ncPerPcts)) * 40)));
      console.log(
        `  ${String(hour).padStart(2, "0")}:00  ${fmt(med).padStart(6)} NC/1%  (n=${vals.length})  ${bar}`,
      );
    }
  }

  console.log("");
}

export async function runWindows(
  args: string[],
  _useDb = false,
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      days: { type: "string", default: "7" },
      since: { type: "string" },
      json: { type: "boolean", default: false },
      verbose: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  let since: Date;
  if (values.since) {
    since = new Date(values.since + "T00:00:00");
  } else {
    since = new Date();
    since.setDate(since.getDate() - (parseInt(values.days!, 10) || 7));
    since.setHours(0, 0, 0, 0);
  }

  const snapshots = await loadSnapshots(since);
  if (snapshots.length === 0) {
    console.log("No tracking data found. Run `cc-analytics track` first.");
    return;
  }

  const windows = buildWindows(snapshots);
  if (windows.length === 0) {
    console.log("No active windows found in the specified range.");
    return;
  }

  if (values.json) {
    const output = {
      generated: new Date().toISOString(),
      range: { since: since.toISOString(), windows_count: windows.length },
      windows: values.verbose
        ? windows
        : windows.map(({ intervals, ...rest }) => rest),
      summary: buildJsonSummary(windows),
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Table output
  const numDays = values.since
    ? Math.ceil((Date.now() - since.getTime()) / 86_400_000)
    : parseInt(values.days!, 10) || 7;

  console.log(
    `\n  Window Ceiling Analysis — ${numDays} day${numDays !== 1 ? "s" : ""} (${windows.length} windows)\n`,
  );

  const headers = [
    "Date",
    "Day",
    "Start",
    "Peak%",
    "NC/1% med",
    "Ceiling",
    "Total NC",
    "Calls",
    "MaxSess",
    "Cache%",
    "Samples",
  ];
  const rows = windows.map((w) => [
    dateLabel(w.start_time),
    w.day_of_week,
    timeLabel(w.start_time),
    `${w.peak_pct}%`,
    w.nc_per_pct_median != null ? fmt(w.nc_per_pct_median) : "-",
    w.implied_ceiling != null ? fmt(w.implied_ceiling) : "-",
    fmt(w.total_nc_tokens),
    String(w.total_api_calls),
    String(w.max_concurrent_sessions),
    `${w.cache_efficiency_pct}%`,
    String(w.nc_per_pct_samples),
  ]);

  console.log(markdownTable(headers, rows));
  console.log("");

  printSummaryStats(windows);

  if (values.verbose) {
    for (const w of windows) {
      console.log(
        `  Window: ${dateLabel(w.start_time)} ${timeLabel(w.start_time)} ${w.day_of_week} (peak ${w.peak_pct}%, ceiling ${w.implied_ceiling != null ? fmt(w.implied_ceiling) : "?"})`,
      );
      console.log(
        "  Time   Pct  D%   NC Tokens  Calls  Sess  NC/1%",
      );
      console.log("  " + "-".repeat(52));
      for (const iv of w.intervals) {
        if ((iv.nc_tokens === 0 && iv.api_calls === 0) || iv.pct == null) continue;
        const t = timeLabel(iv.time);
        const pct = `${Math.round(iv.pct)}%`.padStart(4);
        const dp =
          iv.delta_pct != null && iv.delta_pct > 0
            ? `+${Math.round(iv.delta_pct)}%`.padStart(4)
            : "  - ";
        const nc = fmt(iv.nc_tokens).padStart(9);
        const calls = String(iv.api_calls).padStart(5);
        const sess = String(iv.sessions).padStart(4);
        const npp =
          iv.nc_per_pct != null ? fmt(iv.nc_per_pct).padStart(7) : "    - ";
        console.log(`  ${t} ${pct} ${dp} ${nc} ${calls} ${sess}  ${npp}`);
      }
      console.log("");
    }
  }
}

function buildJsonSummary(windows: WindowSummary[]) {
  const withCeiling = windows.filter((w) => w.implied_ceiling != null);
  if (withCeiling.length === 0) return null;

  const ceilings = withCeiling.map((w) => w.implied_ceiling!);
  const ncPerPcts = withCeiling.map((w) => w.nc_per_pct_median!);

  const byDay: Record<string, { median_nc_per_pct: number; count: number }> = {};
  const dayGroups = new Map<string, number[]>();
  for (const w of withCeiling) {
    if (!dayGroups.has(w.day_of_week)) dayGroups.set(w.day_of_week, []);
    dayGroups.get(w.day_of_week)!.push(w.nc_per_pct_median!);
  }
  for (const [day, vals] of dayGroups) {
    byDay[day] = { median_nc_per_pct: median(vals), count: vals.length };
  }

  const byHour: Record<string, { median_nc_per_pct: number; count: number }> = {};
  const hourGroups = new Map<number, number[]>();
  for (const w of withCeiling) {
    if (!hourGroups.has(w.start_hour)) hourGroups.set(w.start_hour, []);
    hourGroups.get(w.start_hour)!.push(w.nc_per_pct_median!);
  }
  for (const [hour, vals] of hourGroups) {
    byHour[String(hour).padStart(2, "0")] = {
      median_nc_per_pct: median(vals),
      count: vals.length,
    };
  }

  return {
    windows_with_data: withCeiling.length,
    nc_per_pct: {
      median: median(ncPerPcts),
      mean: mean(ncPerPcts),
      min: Math.min(...ncPerPcts),
      max: Math.max(...ncPerPcts),
      variance_ratio: Math.round((Math.max(...ncPerPcts) / Math.min(...ncPerPcts)) * 10) / 10,
    },
    ceiling: {
      median: median(ceilings),
      min: Math.min(...ceilings),
      max: Math.max(...ceilings),
    },
    by_day_of_week: byDay,
    by_start_hour: byHour,
  };
}

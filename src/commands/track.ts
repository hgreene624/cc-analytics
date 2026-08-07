import { parseArgs } from "node:util";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { discoverFiles } from "../discovery.js";
import { parseSessionFile } from "../parser.js";

const TRACKING_DIR = join(homedir(), ".cc-analytics");
const TRACKING_FILE = join(TRACKING_DIR, "usage-tracking.jsonl");
const RATELIMIT_FILE = join(TRACKING_DIR, "latest-ratelimit.json");

interface IntervalTokens {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  non_cache_tokens: number;
  api_calls: number;
  sessions: number;
}

interface TrackingSnapshot {
  timestamp: string;
  session_pct: number | null;
  weekly_pct: number | null;
  session_resets_at: string | null;
  weekly_resets_at: string | null;
  stale: boolean;
  data_stale: boolean;
  interval: IntervalTokens;
  delta_pct: number | null;
}

function printHelp(): void {
  console.log(`
cc-analytics track — Snapshot usage for ceiling tracking

Usage:
  cc-analytics track [options]

Captures a point-in-time snapshot pairing the server's 5h utilization
percentage (from rate limit headers) with actual JSONL token counts
from all active sessions. Designed for cron every 5 minutes.

Each snapshot records:
  - Current 5h% and 7d% from rate limit headers
  - All tokens logged in JSONL since the previous snapshot
  - Delta in 5h% since previous snapshot (same window only)

This lets you correlate: "the server ticked N%, and in that period
we logged X tokens across all sessions."

Options:
  --json              Print snapshot to stdout instead of appending
  --trend             Show recent tracking history
  --days <n>          Days of history with --trend (default: 1)
  --help, -h          Show this help message

Examples:
  cc-analytics track                    # Capture and append
  cc-analytics track --json             # Dry run
  cc-analytics track --trend            # Show today's data
`);
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
  return n.toString();
}

function timeLabel(d: Date): string {
  return (
    String(d.getHours()).padStart(2, "0") +
    ":" +
    String(d.getMinutes()).padStart(2, "0")
  );
}

// --- Rate limit data from status line hook ---

interface RateLimitData {
  session_pct: number | null;
  weekly_pct: number | null;
  session_resets_at: string;
  weekly_resets_at: string;
  data_stale: boolean;
}

async function fetchRateLimitData(): Promise<RateLimitData | null> {
  try {
    const raw = await readFile(RATELIMIT_FILE, "utf-8");
    const data = JSON.parse(raw) as {
      timestamp: string;
      five_hour_pct: number | null;
      five_hour_reset: number | null;
      seven_day_pct: number | null;
      seven_day_reset: number | null;
    };

    // Data source staleness: older than 10 minutes
    const age = Date.now() - new Date(data.timestamp).getTime();
    const dataStale = age > 10 * 60 * 1000;

    if (dataStale && data.five_hour_pct === null && data.seven_day_pct === null) return null;

    return {
      session_pct: data.five_hour_pct,
      weekly_pct: data.seven_day_pct,
      session_resets_at:
        data.five_hour_reset !== null
          ? new Date(data.five_hour_reset * 1000).toISOString()
          : "",
      weekly_resets_at:
        data.seven_day_reset !== null
          ? new Date(data.seven_day_reset * 1000).toISOString()
          : "",
      data_stale: dataStale,
    };
  } catch {
    return null;
  }
}

// --- JSONL interval token counting ---

async function getIntervalTokens(
  since: Date,
  until: Date,
): Promise<IntervalTokens> {
  const files = await discoverFiles({ since, until });

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let apiCalls = 0;
  const sessionPaths = new Set<string>();

  for (const file of files) {
    try {
      const calls = await parseSessionFile(file.path);
      const filtered = calls.filter((c) => {
        const ts = new Date(c.timestamp).getTime();
        return ts > since.getTime() && ts <= until.getTime();
      });
      if (filtered.length > 0) sessionPaths.add(file.path);
      for (const c of filtered) {
        inputTokens += c.inputTokens;
        outputTokens += c.outputTokens;
        cacheReadTokens += c.cacheReadTokens;
        cacheCreationTokens += c.cacheCreationTokens;
        apiCalls++;
      }
    } catch {
      /* skip unreadable files */
    }
  }

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_creation_tokens: cacheCreationTokens,
    total_tokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    non_cache_tokens: inputTokens + outputTokens + cacheCreationTokens,
    api_calls: apiCalls,
    sessions: sessionPaths.size,
  };
}

// --- Read previous snapshot ---

async function readPreviousSnapshot(): Promise<TrackingSnapshot | null> {
  try {
    const raw = await readFile(TRACKING_FILE, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return null;
    const row = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
    // Normalize v1 flat fields to v2 nested interval
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
    // Backfill non_cache_tokens for v2 snapshots that lack it
    const interval = row.interval as Record<string, unknown> | undefined;
    if (interval && interval.non_cache_tokens == null) {
      interval.non_cache_tokens =
        ((interval.input_tokens as number) ?? 0) +
        ((interval.output_tokens as number) ?? 0) +
        ((interval.cache_creation_tokens as number) ?? 0);
    }
    return row as unknown as TrackingSnapshot;
  } catch {
    return null;
  }
}

// --- Trend display ---

async function showTrend(days: number): Promise<void> {
  let lines: string[];
  try {
    const raw = await readFile(TRACKING_FILE, "utf-8");
    lines = raw.trim().split("\n").filter(Boolean);
  } catch {
    console.log("No tracking data found. Run `cc-analytics track` first.");
    return;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const snapshots: TrackingSnapshot[] = [];
  for (const line of lines) {
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      if (new Date(raw.timestamp as string) < cutoff) continue;

      // Normalize v1 format (flat fields) to v2 (nested interval)
      if (!raw.interval && raw.total_tokens != null) {
        raw.interval = {
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          total_tokens: raw.total_tokens as number,
          non_cache_tokens: 0,
          api_calls: raw.api_calls as number,
          sessions: raw.active_sessions as number,
        };
      }
      // Backfill non_cache_tokens for v2 snapshots that lack it
      const interval = raw.interval as Record<string, unknown> | undefined;
      if (interval && interval.non_cache_tokens == null) {
        interval.non_cache_tokens =
          ((interval.input_tokens as number) ?? 0) +
          ((interval.output_tokens as number) ?? 0) +
          ((interval.cache_creation_tokens as number) ?? 0);
      }

      snapshots.push(raw as unknown as TrackingSnapshot);
    } catch {
      /* skip malformed */
    }
  }

  if (snapshots.length === 0) {
    console.log(`No tracking data in the last ${days} day(s).`);
    return;
  }

  // Group by window
  const windows = new Map<string, TrackingSnapshot[]>();
  for (const s of snapshots) {
    const key = s.session_resets_at ?? "unknown";
    if (!windows.has(key)) windows.set(key, []);
    windows.get(key)!.push(s);
  }

  console.log(
    `\n  Ceiling Tracking — last ${days} day(s) (${snapshots.length} snapshots)\n`,
  );

  for (const [windowKey, wSnaps] of windows) {
    if (windowKey !== "unknown") {
      const resetLocal = new Date(windowKey);
      console.log(
        `  Window resets: ${timeLabel(resetLocal)} local`,
      );
    }
    // Compute window duration for pace delta
    const windowResetMs = windowKey !== "unknown" ? new Date(windowKey).getTime() : 0;
    const windowDurationMs = 5 * 60 * 60 * 1000; // 5 hours
    const windowStartMs = windowResetMs > 0 ? windowResetMs - windowDurationMs : 0;

    console.log(
      "  Time    5h%  Pace  Δ%     Interval Tokens   NC Tokens  Calls  Sess   Tot/1%    NC/1%",
    );
    console.log("  " + "─".repeat(92));

    // Collect tokens/1% values for summary
    const tokensPerPctValues: number[] = [];
    const ncTokensPerPctValues: number[] = [];

    // Accumulate tokens since last % change — flat intervals contribute
    // to the next tick
    let accumulatedTokens = 0;
    let accumulatedNcTokens = 0;

    for (const s of wSnaps) {
      const t = timeLabel(new Date(s.timestamp));
      const pct =
        s.session_pct != null ? `${Math.round(s.session_pct)}%`.padStart(4) : " n/a";
      const staleFlag = s.stale ? "*" : s.data_stale ? "~" : " ";

      // Pace delta: (elapsed_% - used_%) — positive = headroom
      let paceStr: string;
      if (s.session_pct != null && windowStartMs > 0) {
        const nowMs = new Date(s.timestamp).getTime();
        const elapsedFrac = Math.min(1, Math.max(0, (nowMs - windowStartMs) / windowDurationMs));
        const elapsedPct = elapsedFrac * 100;
        const pace = Math.round(elapsedPct - s.session_pct);
        if (pace >= 0) {
          paceStr = `+${pace}%`.padStart(5);
        } else {
          paceStr = `${pace}%`.padStart(5);
        }
      } else {
        paceStr = "   — ";
      }

      const intervalTotal = s.interval?.total_tokens ?? 0;
      const intervalNc = s.interval?.non_cache_tokens ?? 0;
      accumulatedTokens += intervalTotal;
      accumulatedNcTokens += intervalNc;

      let dpctStr: string;
      if (s.delta_pct != null && s.delta_pct > 0) {
        dpctStr = `+${Math.round(s.delta_pct)}%`.padStart(4);
      } else {
        dpctStr = "  — ";
      }

      const intTokens = s.interval ? fmt(s.interval.total_tokens).padStart(14) : "           n/a";
      const ncTokens = s.interval ? fmt(intervalNc).padStart(9) : "      n/a";
      const calls = s.interval ? String(s.interval.api_calls).padStart(5) : "  n/a";
      const sess = s.interval ? String(s.interval.sessions).padStart(4) : " n/a";

      let tppStr: string;
      let ncTppStr: string;
      if (
        s.delta_pct != null &&
        s.delta_pct > 0 &&
        accumulatedTokens > 0
      ) {
        const roundedDelta = Math.round(s.delta_pct);
        const tpp = Math.round(accumulatedTokens / roundedDelta);
        const ncTpp = Math.round(accumulatedNcTokens / roundedDelta);
        tppStr = fmt(tpp).padStart(9);
        ncTppStr = fmt(ncTpp).padStart(8);
        tokensPerPctValues.push(tpp);
        ncTokensPerPctValues.push(ncTpp);
        // Reset accumulators after a tick
        accumulatedTokens = 0;
        accumulatedNcTokens = 0;
      } else {
        tppStr = "      — ";
        ncTppStr = "     — ";
      }

      console.log(
        `  ${t}${staleFlag} ${pct} ${paceStr} ${dpctStr}  ${intTokens}  ${ncTokens}  ${calls}  ${sess}  ${tppStr}  ${ncTppStr}`,
      );
    }

    // Summary
    if (tokensPerPctValues.length >= 2) {
      tokensPerPctValues.sort((a, b) => a - b);
      ncTokensPerPctValues.sort((a, b) => a - b);
      const median =
        tokensPerPctValues[Math.floor(tokensPerPctValues.length / 2)];
      const avg =
        Math.round(
          tokensPerPctValues.reduce((a, b) => a + b, 0) /
            tokensPerPctValues.length,
        );
      const min = tokensPerPctValues[0];
      const max = tokensPerPctValues[tokensPerPctValues.length - 1];
      const ncMedian =
        ncTokensPerPctValues[Math.floor(ncTokensPerPctValues.length / 2)];
      const ncAvg =
        Math.round(
          ncTokensPerPctValues.reduce((a, b) => a + b, 0) /
            ncTokensPerPctValues.length,
        );
      console.log("");
      console.log(
        `  Total tokens/1%:     median ${fmt(median)} | avg ${fmt(avg)} | range ${fmt(min)}–${fmt(max)} (n=${tokensPerPctValues.length})`,
      );
      console.log(
        `  Non-cache tokens/1%: median ${fmt(ncMedian)} | avg ${fmt(ncAvg)}`,
      );
      console.log(
        `  Implied ceiling: ${fmt(median * 100)} total | ${fmt(ncMedian * 100)} non-cache`,
      );
    } else if (tokensPerPctValues.length === 1) {
      console.log("");
      console.log(
        `  Total tokens/1%: ${fmt(tokensPerPctValues[0])} | Non-cache/1%: ${fmt(ncTokensPerPctValues[0] ?? 0)} (1 sample — need more data)`,
      );
    }

    console.log("");
  }
}

// --- Main ---

export async function runTrack(
  args: string[],
  _useDb = false,
): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: "boolean", default: false },
      trend: { type: "boolean", default: false },
      days: { type: "string", default: "1" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  if (values.trend) {
    await showTrend(parseInt(values.days!, 10) || 1);
    return;
  }

  const now = new Date();

  // Read rate limit headers
  const rlData = await fetchRateLimitData();

  // Detect stale: resets_at is in the past
  const resetsAtMs = rlData?.session_resets_at
    ? new Date(rlData.session_resets_at).getTime()
    : null;
  const isStale = resetsAtMs !== null && resetsAtMs < now.getTime();

  // Read previous snapshot to determine interval window and compute delta_pct
  const prev = await readPreviousSnapshot();

  // Interval: tokens from all JSONL calls since previous snapshot
  const intervalSince = prev ? new Date(prev.timestamp) : new Date(now.getTime() - 6 * 60 * 1000);
  const interval = await getIntervalTokens(intervalSince, now);

  // Delta pct: only compare within the same rate limit window
  // Round to integers to eliminate floating-point noise (e.g. 7.000000000000001)
  let deltaPct: number | null = null;
  if (
    !isStale &&
    rlData &&
    prev &&
    !prev.stale &&
    prev.session_pct != null &&
    rlData.session_pct != null &&
    prev.session_resets_at === rlData.session_resets_at
  ) {
    const raw = Math.round(rlData.session_pct) - Math.round(prev.session_pct);
    // Only record positive deltas — negative means the window is sliding, not real consumption
    deltaPct = raw > 0 ? raw : null;
  }

  const snapshot: TrackingSnapshot = {
    timestamp: now.toISOString(),
    session_pct: rlData?.session_pct ?? null,
    weekly_pct: rlData?.weekly_pct ?? null,
    session_resets_at: rlData?.session_resets_at ?? null,
    weekly_resets_at: rlData?.weekly_resets_at ?? null,
    stale: isStale,
    data_stale: rlData?.data_stale ?? true,
    interval,
    delta_pct: deltaPct,
  };

  if (values.json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  // Append to tracking file
  await mkdir(TRACKING_DIR, { recursive: true });
  await appendFile(TRACKING_FILE, JSON.stringify(snapshot) + "\n", "utf-8");

  // Print one-line summary
  const pctStr =
    rlData?.session_pct != null ? `${Math.round(rlData.session_pct)}%` : "n/a";
  const weekStr =
    rlData?.weekly_pct != null ? `${Math.round(rlData.weekly_pct)}%` : "n/a";
  const staleFlag = isStale ? " [STALE]" : (rlData?.data_stale ? " [DATA STALE]" : "");
  const dpctStr =
    deltaPct != null && deltaPct > 0 ? ` (+${deltaPct}%)` : "";

  // Accumulate tokens from preceding flat-delta intervals for accurate tokens/1%
  let tppStr = "";
  if (deltaPct != null && deltaPct > 0) {
    let accumulated = interval.total_tokens;
    let accumulatedNc = interval.non_cache_tokens;
    try {
      const raw = await readFile(TRACKING_FILE, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      // Walk backwards to sum tokens from flat-delta intervals
      for (let i = lines.length - 1; i >= 0; i--) {
        const row = JSON.parse(lines[i]) as Record<string, unknown>;
        const rowDelta = row.delta_pct as number | null;
        if (rowDelta != null && rowDelta > 0) break; // hit a previous tick, stop
        const rowInterval = row.interval as IntervalTokens | undefined;
        if (rowInterval) {
          accumulated += rowInterval.total_tokens ?? 0;
          accumulatedNc += rowInterval.non_cache_tokens ?? 0;
        }
      }
    } catch { /* no history, just use current interval */ }
    tppStr = ` | ${fmt(Math.round(accumulated / deltaPct))}/1% (${fmt(Math.round(accumulatedNc / deltaPct))} NC/1%)`;
  }

  // Pace delta
  let paceStr = "";
  if (rlData?.session_pct != null && rlData.session_resets_at) {
    const resetMs = new Date(rlData.session_resets_at).getTime();
    const windowMs = 5 * 60 * 60 * 1000;
    const startMs = resetMs - windowMs;
    const elapsedPct = Math.min(100, Math.max(0, ((now.getTime() - startMs) / windowMs) * 100));
    const pace = Math.round(elapsedPct - rlData.session_pct);
    paceStr = pace >= 0 ? ` [pace: +${pace}%]` : ` [pace: ${pace}%]`;
  }

  console.log(
    `[${timeLabel(now)}] 5h: ${pctStr}${dpctStr}${staleFlag}${paceStr} | 7d: ${weekStr} | Interval: ${fmt(interval.total_tokens)} (${fmt(interval.non_cache_tokens)} NC) (${interval.api_calls} calls, ${interval.sessions} sess)${tppStr}`,
  );
}

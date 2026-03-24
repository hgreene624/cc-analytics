/**
 * Format a token count for display.
 * e.g., 1234567 → "1.2M", 456789 → "457K", 1234 → "1,234"
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 10_000) {
    return `${Math.round(n / 1_000)}K`;
  }
  return n.toLocaleString("en-US");
}

/**
 * Format a duration in milliseconds to human-readable form.
 * e.g., 8100000 → "2h 15m", 2700000 → "45m", 180000 → "3m"
 */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalMinutes = Math.round(ms / 60_000);

  if (totalMinutes < 1) return "<1m";

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

/**
 * Truncate a session ID to first N characters (default 8).
 */
export function truncateSessionId(id: string, len = 8): string {
  return id.slice(0, len);
}

/**
 * Format a ratio as a percentage string.
 * e.g., 0.452 → "45.2%"
 */
export function formatPercent(ratio: number): string {
  if (!isFinite(ratio)) return "0.0%";
  return `${(ratio * 100).toFixed(1)}%`;
}

/**
 * Format an ISO timestamp to a short local time string.
 */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Render a markdown table from headers and rows.
 */
export function markdownTable(headers: string[], rows: string[][]): string {
  const colWidths = headers.map((h, i) => {
    const maxRow = rows.reduce((max, row) => Math.max(max, (row[i] ?? "").length), 0);
    return Math.max(h.length, maxRow);
  });

  const headerLine = "| " + headers.map((h, i) => h.padEnd(colWidths[i])).join(" | ") + " |";
  const separatorLine = "| " + colWidths.map((w) => "-".repeat(w)).join(" | ") + " |";
  const dataLines = rows.map(
    (row) => "| " + row.map((cell, i) => (cell ?? "").padEnd(colWidths[i])).join(" | ") + " |"
  );

  return [headerLine, separatorLine, ...dataLines].join("\n");
}

/**
 * Truncate a project directory path for display.
 */
export function formatProjectDir(dir: string): string {
  // Show last 2 path segments for readability
  const parts = dir.split("/").filter(Boolean);
  if (parts.length <= 2) return dir;
  return ".../" + parts.slice(-2).join("/");
}

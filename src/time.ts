/**
 * Parse a time value string into a Date.
 *
 * Supported formats:
 * - ISO date: "2026-03-24", "2026-03-24T08:00:00"
 * - Relative: "24h", "7d", "48h", "30m"
 * - Named: "today", "yesterday"
 */
export function parseTimeValue(value: string): Date {
  const now = new Date();
  const lower = value.toLowerCase().trim();

  // Named values
  if (lower === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  if (lower === "yesterday") {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  // Relative: Nh, Nd, Nm
  const relativeMatch = lower.match(/^(\d+)(h|d|m)$/);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2];
    const d = new Date(now);

    switch (unit) {
      case "h":
        d.setHours(d.getHours() - amount);
        break;
      case "d":
        d.setDate(d.getDate() - amount);
        break;
      case "m":
        d.setMinutes(d.getMinutes() - amount);
        break;
    }

    return d;
  }

  // ISO date or datetime
  const parsed = new Date(value);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }

  throw new Error(`Cannot parse time value: "${value}". Use ISO date, relative (24h, 7d), or named (today, yesterday).`);
}

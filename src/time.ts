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

  // Clock time: "5am", "5pm", "5:30am", "14:00", "5:30pm" — interpreted as today
  const clockMatch = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (clockMatch) {
    let hours = parseInt(clockMatch[1], 10);
    const minutes = clockMatch[2] ? parseInt(clockMatch[2], 10) : 0;
    const ampm = clockMatch[3];

    if (ampm === "pm" && hours < 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;

    const d = new Date(now);
    d.setHours(hours, minutes, 0, 0);
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

import { parseArgs } from "node:util";
import { parseTimeValue } from "../time.js";
import { discoverFiles } from "../discovery.js";
import { parseSessionFile } from "../parser.js";
import { formatTokens, formatPercent, formatProjectDir } from "../formatter.js";
import type { ApiCall } from "../parser.js";

function printHelp(): void {
  console.log(`
cc-analytics audit — Full comprehensive usage audit

Usage:
  cc-analytics audit [options]

Options:
  --since <value>   Start of time window (ISO date, relative: 24h/7d, or: today/yesterday)
  --json            Output as JSON instead of markdown
  --help, -h        Show this help message

Runs all analysis commands in sequence and combines them into a single report:
  1. trend (14 days)       — daily totals, spot the spike
  2. compare (week/week)   — what changed
  3. top (top 10)          — biggest consumers
  4. anomalies             — statistical outliers
  5. models                — model mix
  6. cache                 — efficiency report
  7. projects              — heaviest workflows

Examples:
  cc-analytics audit
  cc-analytics audit --since today
  cc-analytics audit --json
`);
}

/**
 * Capture console.log output from an async function.
 * Temporarily replaces console.log, collects all output, then restores it.
 */
async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

interface AuditSummary {
  totalTokens: number;
  rateLimitTokens: number;
  sessionCount: number;
  deltaPercent: number | null;
  anomalyCount: number;
  worstCacheEfficiency: { project: string; ratio: number } | null;
  periodDays: number;
}

export async function runAudit(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      since: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  const sinceArg = values.since;

  // Pre-compute summary data for the executive summary
  const summary = await computeAuditSummary(sinceArg);

  // Capture output from each sub-command
  const sections: { title: string; content: string }[] = [];

  // 1. Trend (14 days)
  const trendOutput = await captureOutput(async () => {
    const { runTrend } = await import("./trend.js");
    await runTrend(["--days", "14"]);
  });
  sections.push({ title: "Daily Trend (14 days)", content: trendOutput });

  // 2. Compare (this week vs last week)
  const compareOutput = await captureOutput(async () => {
    const { runCompare } = await import("./compare.js");
    await runCompare(["--a", "7d", "--b", "14d..8d"]);
  });
  sections.push({ title: "Period Comparison (This Week vs Last Week)", content: compareOutput });

  // 3. Top (top 10, current window)
  const topArgs = sinceArg ? ["--since", sinceArg, "-n", "10"] : ["-n", "10"];
  const topOutput = await captureOutput(async () => {
    const { runTop } = await import("./top.js");
    await runTop(topArgs);
  });
  sections.push({ title: "Top 10 Sessions", content: topOutput });

  // 4. Anomalies
  const anomalyArgs = sinceArg ? ["--since", sinceArg] : [];
  const anomalyOutput = await captureOutput(async () => {
    const { runAnomalies } = await import("./anomalies.js");
    await runAnomalies(anomalyArgs);
  });
  sections.push({ title: "Anomaly Detection", content: anomalyOutput });

  // 5. Models
  const modelsArgs = sinceArg ? ["--since", sinceArg] : [];
  const modelsOutput = await captureOutput(async () => {
    const { runModels } = await import("./models.js");
    await runModels(modelsArgs);
  });
  sections.push({ title: "Model Mix", content: modelsOutput });

  // 6. Cache
  const cacheArgs = sinceArg ? ["--since", sinceArg] : [];
  const cacheOutput = await captureOutput(async () => {
    const { runCache } = await import("./cache.js");
    await runCache(cacheArgs);
  });
  sections.push({ title: "Cache Efficiency", content: cacheOutput });

  // 7. Projects
  const projectsArgs = sinceArg ? ["--since", sinceArg] : [];
  const projectsOutput = await captureOutput(async () => {
    const { runProjects } = await import("./projects.js");
    await runProjects(projectsArgs);
  });
  sections.push({ title: "Heaviest Workflows", content: projectsOutput });

  if (values.json) {
    const jsonOutput = {
      summary,
      sections: sections.map((s) => ({ title: s.title, content: s.content })),
    };
    console.log(JSON.stringify(jsonOutput, null, 2));
    return;
  }

  // Render full report
  console.log("\n# Claude Code Usage Audit Report\n");
  console.log(`_Generated: ${new Date().toISOString()}_\n`);

  // Executive summary
  console.log("## Executive Summary\n");
  console.log(`- **Total tokens:** ${formatTokens(summary.totalTokens)} (${formatTokens(summary.rateLimitTokens)} rate-limit counted)`);
  if (summary.deltaPercent !== null) {
    const arrow = summary.deltaPercent > 0 ? "+" : "";
    console.log(`- **Week-over-week change:** ${arrow}${summary.deltaPercent.toFixed(1)}%`);
  }
  console.log(`- **Sessions:** ${summary.sessionCount}`);
  console.log(`- **Anomalies detected:** ${summary.anomalyCount}`);
  if (summary.worstCacheEfficiency) {
    console.log(`- **Worst cache efficiency:** ${formatPercent(summary.worstCacheEfficiency.ratio)} (${summary.worstCacheEfficiency.project})`);
  }
  console.log("");

  // Render each section
  for (const section of sections) {
    console.log(`---\n\n## ${section.title}\n`);
    console.log(section.content.trim());
    console.log("");
  }
}

/**
 * Compute summary statistics for the executive summary.
 */
async function computeAuditSummary(sinceArg?: string): Promise<AuditSummary> {
  const since = sinceArg ? parseTimeValue(sinceArg) : undefined;
  const files = await discoverFiles({ since });

  let totalTokens = 0;
  let rateLimitTokens = 0;
  const sessionIds = new Set<string>();
  const allCalls: ApiCall[] = [];
  const sessionProject = new Map<string, string>();

  for (const file of files) {
    const dir = file.projectSlug ? decodeURIComponent(file.projectSlug) : "unknown";
    try {
      const calls = await parseSessionFile(file.path);
      for (const call of calls) {
        totalTokens += call.totalTokens;
        rateLimitTokens += call.rateLimitTokens;
        sessionIds.add(call.sessionId);
        allCalls.push(call);
        if (!sessionProject.has(call.sessionId)) {
          sessionProject.set(call.sessionId, dir);
        }
      }
    } catch { /* skip */ }
  }

  // Anomaly count: group by session, find >2σ outliers
  const sessionTokens = new Map<string, number>();
  for (const call of allCalls) {
    sessionTokens.set(call.sessionId, (sessionTokens.get(call.sessionId) ?? 0) + call.totalTokens);
  }
  let anomalyCount = 0;
  const sessionTotals = Array.from(sessionTokens.values());
  if (sessionTotals.length > 1) {
    const mean = sessionTotals.reduce((a, b) => a + b, 0) / sessionTotals.length;
    const variance = sessionTotals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / sessionTotals.length;
    const stddev = Math.sqrt(variance);
    const threshold = mean + 2 * stddev;
    anomalyCount = sessionTotals.filter((t) => t > threshold).length;
  }

  // Week-over-week delta
  let deltaPercent: number | null = null;
  const now = new Date();
  const thisWeekStart = new Date(now);
  thisWeekStart.setDate(thisWeekStart.getDate() - 7);
  const lastWeekStart = new Date(now);
  lastWeekStart.setDate(lastWeekStart.getDate() - 14);

  let thisWeekTokens = 0;
  let lastWeekTokens = 0;
  for (const call of allCalls) {
    const t = new Date(call.timestamp);
    if (t >= thisWeekStart) {
      thisWeekTokens += call.totalTokens;
    } else if (t >= lastWeekStart && t < thisWeekStart) {
      lastWeekTokens += call.totalTokens;
    }
  }
  if (lastWeekTokens > 0) {
    deltaPercent = ((thisWeekTokens - lastWeekTokens) / lastWeekTokens) * 100;
  }

  // Worst cache efficiency by project
  const projectCacheStats = new Map<string, { cacheRead: number; totalInput: number }>();
  for (const call of allCalls) {
    const dir = sessionProject.get(call.sessionId) ?? "unknown";
    if (!projectCacheStats.has(dir)) {
      projectCacheStats.set(dir, { cacheRead: 0, totalInput: 0 });
    }
    const entry = projectCacheStats.get(dir)!;
    entry.cacheRead += call.cacheReadTokens;
    entry.totalInput += call.inputTokens + call.cacheReadTokens;
  }

  let worstCacheEfficiency: { project: string; ratio: number } | null = null;
  for (const [project, data] of projectCacheStats) {
    if (data.totalInput > 10000) {
      const ratio = data.cacheRead / data.totalInput;
      if (worstCacheEfficiency === null || ratio < worstCacheEfficiency.ratio) {
        worstCacheEfficiency = { project: formatProjectDir(project), ratio };
      }
    }
  }

  return {
    totalTokens,
    rateLimitTokens,
    sessionCount: sessionIds.size,
    deltaPercent,
    anomalyCount,
    worstCacheEfficiency,
    periodDays: sinceArg ? Math.ceil((now.getTime() - (since?.getTime() ?? now.getTime())) / 86400000) : 14,
  };
}

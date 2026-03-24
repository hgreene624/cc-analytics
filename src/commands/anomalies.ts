import { parseArgs } from "node:util";
import { discoverFiles } from "../discovery.js";
import { parseSessionFile } from "../parser.js";
import { aggregateSessions } from "../aggregator.js";
import { parseTimeValue } from "../time.js";
import {
  formatTokens,
  truncateSessionId,
  markdownTable,
  formatProjectDir,
} from "../formatter.js";
import type { ApiCall } from "../parser.js";

function printHelp(): void {
  console.log(`
cc-analytics anomalies — Flag outlier sessions

Usage:
  cc-analytics anomalies [options]

Options:
  --since <value>   Start of time window (ISO date, relative: 24h/7d, or: today/yesterday)
  --until <value>   End of time window (same formats as --since)
  --sigma <number>  Standard deviations threshold (default: 2)
  --json            Output as JSON instead of markdown
  --help, -h        Show this help message

Examples:
  cc-analytics anomalies --since 7d
  cc-analytics anomalies --since today --sigma 1.5
  cc-analytics anomalies --since 7d --json
`);
}

interface AnomalyResult {
  sessionId: string;
  projectDir: string;
  totalTokens: number;
  model: string;
  teamName?: string;
  isTeam: boolean;
  sigmaAbove: number;
  groupMean: number;
  groupStddev: number;
}

export async function runAnomalies(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      since: { type: "string" },
      until: { type: "string" },
      sigma: { type: "string", default: "2" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    return;
  }

  const since = values.since ? parseTimeValue(values.since) : undefined;
  const until = values.until ? parseTimeValue(values.until) : undefined;
  const sigmaThreshold = parseFloat(values.sigma!) || 2;

  const files = await discoverFiles({ since, until });
  if (files.length === 0) {
    console.log("No JSONL files found in the specified time window.");
    return;
  }

  const callsByFile = new Map<string, ApiCall[]>();
  for (const file of files) {
    try {
      const calls = await parseSessionFile(file.path);
      if (calls.length > 0) callsByFile.set(file.path, calls);
    } catch { /* skip */ }
  }

  const sessions = aggregateSessions(files, callsByFile);

  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }

  // Group sessions by category: (team vs solo) × (primary model)
  type GroupKey = string;
  const groups = new Map<GroupKey, typeof sessions>();

  for (const session of sessions) {
    const isTeam = !!session.teamName;
    const modelFamily = extractModelFamily(session.primaryModel);
    const key = `${isTeam ? "team" : "solo"}:${modelFamily}`;

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(session);
  }

  // Compute mean + stddev per group, flag anomalies
  const anomalies: AnomalyResult[] = [];

  for (const [_key, groupSessions] of groups) {
    if (groupSessions.length < 3) continue; // Need at least 3 sessions for meaningful stats

    const tokens = groupSessions.map((s) => s.totalTokens);
    const mean = tokens.reduce((a, b) => a + b, 0) / tokens.length;
    const variance = tokens.reduce((sum, t) => sum + (t - mean) ** 2, 0) / tokens.length;
    const stddev = Math.sqrt(variance);

    if (stddev === 0) continue; // All sessions same size

    const threshold = mean + sigmaThreshold * stddev;

    for (const session of groupSessions) {
      if (session.totalTokens > threshold) {
        const sigmaAbove = (session.totalTokens - mean) / stddev;
        anomalies.push({
          sessionId: session.sessionId,
          projectDir: session.projectDir,
          totalTokens: session.totalTokens,
          model: session.primaryModel,
          teamName: session.teamName,
          isTeam: !!session.teamName,
          sigmaAbove,
          groupMean: Math.round(mean),
          groupStddev: Math.round(stddev),
        });
      }
    }
  }

  // Sort by deviation (most anomalous first)
  anomalies.sort((a, b) => b.sigmaAbove - a.sigmaAbove);

  if (values.json) {
    console.log(JSON.stringify({
      anomalies,
      summary: {
        totalSessions: sessions.length,
        anomalyCount: anomalies.length,
        sigmaThreshold,
      },
    }, null, 2));
    return;
  }

  console.log(`\n**Anomaly Detection** — ${anomalies.length} outlier${anomalies.length !== 1 ? "s" : ""} found (σ > ${sigmaThreshold}) out of ${sessions.length} sessions\n`);

  if (anomalies.length === 0) {
    console.log("No anomalous sessions detected.");
    return;
  }

  const headers = ["#", "Session", "Project", "Tokens", "σ Above", "Group Mean", "Model", "Team"];
  const rows = anomalies.map((a, i) => [
    String(i + 1),
    truncateSessionId(a.sessionId),
    formatProjectDir(a.projectDir),
    formatTokens(a.totalTokens),
    `${a.sigmaAbove.toFixed(1)}σ`,
    formatTokens(a.groupMean),
    a.model.replace("claude-", ""),
    a.teamName ?? (a.isTeam ? "team" : "solo"),
  ]);

  console.log(markdownTable(headers, rows));
}

/**
 * Extract a model family name for grouping (e.g., "opus", "sonnet", "haiku").
 */
function extractModelFamily(model: string): string {
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
  return model;
}

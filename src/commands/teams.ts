import { parseArgs } from "node:util";
import { discoverFiles } from "../discovery.js";
import { parseSessionFile } from "../parser.js";
import { aggregateSessions } from "../aggregator.js";
import { parseTimeValue } from "../time.js";
import {
  formatTokens,
  formatDuration,
  formatPercent,
  truncateSessionId,
  markdownTable,
} from "../formatter.js";
import { openDatabase, closeDatabase } from "../db/connection.js";
import { querySessions, queryApiCalls } from "../db/queries.js";
import type { ApiCall } from "../parser.js";

function printHelp(): void {
  console.log(`
cc-analytics teams — Team usage analysis

Usage:
  cc-analytics teams [options]

Options:
  --since <value>   Start of time window (ISO date, relative: 24h/7d, or: today/yesterday)
  --until <value>   End of time window (same formats as --since)
  --json            Output as JSON instead of markdown
  --help, -h        Show this help message

Examples:
  cc-analytics teams --since today
  cc-analytics teams --since 7d
  cc-analytics teams --since 7d --json
`);
}

interface AgentStats {
  agentName: string;
  totalTokens: number;
  callCount: number;
  percentOfTeam: number;
}

interface TeamStats {
  teamName: string;
  totalTokens: number;
  agentCount: number;
  durationMs: number;
  sessionCount: number;
  agents: AgentStats[];
  dominantAgent: boolean; // true if any agent > 50% of team total
}

export async function runTeams(args: string[], useDb = false): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      since: { type: "string" },
      until: { type: "string" },
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

  let sessions;
  let allCalls: ApiCall[];
  if (useDb) {
    const db = openDatabase();
    sessions = querySessions(db, { since, until });
    allCalls = queryApiCalls(db, { since, until });
    closeDatabase();
  } else {
    const files = await discoverFiles({ since, until });
    if (files.length === 0) {
      console.log("No JSONL files found in the specified time window.");
      return;
    }

    const callsByFile = new Map<string, ApiCall[]>();
    allCalls = [];
    for (const file of files) {
      try {
        const calls = await parseSessionFile(file.path);
        if (calls.length > 0) {
          callsByFile.set(file.path, calls);
          allCalls.push(...calls);
        }
      } catch { /* skip */ }
    }

    sessions = aggregateSessions(files, callsByFile);
  }

  // Filter to team sessions only
  const teamSessions = sessions.filter((s) => s.teamName);

  if (teamSessions.length === 0) {
    console.log("No team sessions found in the specified time window.");
    return;
  }

  // Group by team name, aggregating across sessions
  const teamMap = new Map<string, {
    totalTokens: number;
    durationMs: number;
    sessionCount: number;
    sessionIds: Set<string>;
    agentTokens: Map<string, { totalTokens: number; callCount: number }>;
  }>();

  // Get per-agent data from raw calls
  const teamCalls = allCalls.filter((c) => c.teamName);

  for (const call of teamCalls) {
    const team = call.teamName!;
    if (!teamMap.has(team)) {
      teamMap.set(team, {
        totalTokens: 0,
        durationMs: 0,
        sessionCount: 0,
        sessionIds: new Set(),
        agentTokens: new Map(),
      });
    }
    const entry = teamMap.get(team)!;
    entry.totalTokens += call.totalTokens;
    entry.sessionIds.add(call.sessionId);

    const agentName = call.agentName ?? "main";
    if (!entry.agentTokens.has(agentName)) {
      entry.agentTokens.set(agentName, { totalTokens: 0, callCount: 0 });
    }
    const agentEntry = entry.agentTokens.get(agentName)!;
    agentEntry.totalTokens += call.totalTokens;
    agentEntry.callCount += 1;
  }

  // Add duration from session summaries
  for (const session of teamSessions) {
    if (session.teamName && teamMap.has(session.teamName)) {
      const entry = teamMap.get(session.teamName)!;
      entry.durationMs += session.durationMs;
      entry.sessionCount += 1;
    }
  }

  const teams: TeamStats[] = Array.from(teamMap.entries())
    .map(([teamName, data]) => {
      const agents: AgentStats[] = Array.from(data.agentTokens.entries())
        .map(([agentName, agentData]) => ({
          agentName,
          totalTokens: agentData.totalTokens,
          callCount: agentData.callCount,
          percentOfTeam: data.totalTokens > 0 ? agentData.totalTokens / data.totalTokens : 0,
        }))
        .sort((a, b) => b.totalTokens - a.totalTokens);

      const dominantAgent = agents.some((a) => a.percentOfTeam > 0.5);

      return {
        teamName,
        totalTokens: data.totalTokens,
        agentCount: agents.length,
        durationMs: data.durationMs,
        sessionCount: data.sessionCount,
        agents,
        dominantAgent,
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);

  if (values.json) {
    console.log(JSON.stringify({ teams }, null, 2));
    return;
  }

  const grandTotal = teams.reduce((sum, t) => sum + t.totalTokens, 0);
  console.log(`\n**Team Analysis** — ${teams.length} teams, ${formatTokens(grandTotal)} total tokens\n`);

  // Team summary table
  const headers = ["Team", "Total Tokens", "Agents", "Duration", "Sessions", "Dominant?"];
  const rows = teams.map((t) => [
    t.teamName,
    formatTokens(t.totalTokens),
    String(t.agentCount),
    formatDuration(t.durationMs),
    String(t.sessionCount),
    t.dominantAgent ? "YES" : "-",
  ]);

  console.log(markdownTable(headers, rows));

  // Per-team agent breakdowns
  for (const team of teams) {
    console.log(`\n**${team.teamName}** — ${formatTokens(team.totalTokens)} tokens, ${team.agentCount} agents\n`);

    const agentHeaders = ["Agent", "Tokens", "% of Team", "Calls"];
    const agentRows = team.agents.map((a) => [
      a.agentName,
      formatTokens(a.totalTokens),
      formatPercent(a.percentOfTeam) + (a.percentOfTeam > 0.5 ? " ⚠" : ""),
      String(a.callCount),
    ]);

    console.log(markdownTable(agentHeaders, agentRows));
  }
}

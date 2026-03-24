import { parseArgs } from "node:util";
import { parseSessionFile } from "../parser.js";
import type { SessionSummary } from "../aggregator.js";
import {
  formatTokens,
  formatDuration,
  formatTime,
  truncateSessionId,
  markdownTable,
  formatPercent,
  formatProjectDir,
} from "../formatter.js";
import type { ApiCall } from "../parser.js";

function printHelp(): void {
  console.log(`
cc-analytics detail — Drill into a single session

Usage:
  cc-analytics detail <session-id> [options]

Arguments:
  session-id        Full or partial session ID (prefix match)

Options:
  --json            Output as JSON instead of markdown
  --help, -h        Show this help message

Examples:
  cc-analytics detail abc12345
  cc-analytics detail abc12345-6789-0123-4567-890abcdef012
  cc-analytics detail abc12345 --json
`);
}

export async function runDetail(args: string[]): Promise<void> {
  // Extract positional session ID before parseArgs
  const positionalArgs: string[] = [];
  const flagArgs: string[] = [];
  for (const arg of args) {
    if (arg.startsWith("--") || arg.startsWith("-")) {
      flagArgs.push(arg);
    } else {
      positionalArgs.push(arg);
    }
  }

  const { values } = parseArgs({
    args: flagArgs,
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help || positionalArgs.length === 0) {
    printHelp();
    return;
  }

  const searchId = positionalArgs[0].toLowerCase();

  // Find files containing this session ID using grep for speed
  const { execSync } = await import("node:child_process");
  const { homedir } = await import("node:os");
  const basePath = `${homedir()}/.claude/projects`;

  let matchingFiles: string[];
  try {
    const grepResult = execSync(
      `grep -rl "${searchId}" "${basePath}" --include="*.jsonl" 2>/dev/null || true`,
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 }
    ).trim();
    matchingFiles = grepResult ? grepResult.split("\n").filter(Boolean) : [];
  } catch {
    matchingFiles = [];
  }

  if (matchingFiles.length === 0) {
    console.error(`No session found matching "${searchId}".`);
    process.exit(1);
  }

  // Parse only matching files
  const allCalls: ApiCall[] = [];

  for (const filePath of matchingFiles) {
    try {
      const calls = await parseSessionFile(filePath);
      allCalls.push(...calls);
    } catch { /* skip */ }
  }

  // Find matching session(s) by prefix
  const sessionIds = new Set(allCalls.map((c) => c.sessionId));
  const matches = Array.from(sessionIds).filter((id) =>
    id.toLowerCase().startsWith(searchId)
  );

  if (matches.length === 0) {
    console.error(`No session found matching "${searchId}".`);
    process.exit(1);
  }

  if (matches.length > 1) {
    console.error(`Ambiguous session ID "${searchId}" matches ${matches.length} sessions:`);
    for (const m of matches.slice(0, 10)) {
      console.error(`  ${m}`);
    }
    process.exit(1);
  }

  const sessionId = matches[0];

  // Get all API calls for this session
  const sessionCalls = allCalls
    .filter((c) => c.sessionId === sessionId)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  if (sessionCalls.length === 0) {
    console.error(`Session ${sessionId} found but has no API calls.`);
    process.exit(1);
  }

  // Build session info from raw calls
  const firstSeen = sessionCalls[0].timestamp;
  const lastSeen = sessionCalls[sessionCalls.length - 1].timestamp;
  const durationMs = new Date(lastSeen).getTime() - new Date(firstSeen).getTime();
  let totalTokens = 0;
  let rateLimitTokens = 0;
  const agentSet = new Set<string>();
  let teamName: string | undefined;
  const modelCounts = new Map<string, number>();

  for (const call of sessionCalls) {
    totalTokens += call.totalTokens;
    rateLimitTokens += call.rateLimitTokens;
    if (call.agentName) agentSet.add(call.agentName);
    if (call.teamName && !teamName) teamName = call.teamName;
    modelCounts.set(call.model, (modelCounts.get(call.model) ?? 0) + 1);
  }

  let primaryModel = "";
  let bestCount = 0;
  for (const [model, count] of modelCounts) {
    if (count > bestCount) { primaryModel = model; bestCount = count; }
  }

  // Build a simple project dir from the file path
  const projectDir = matchingFiles[0]
    .replace(`${basePath}/`, "")
    .split("/")[0];

  const session = {
    sessionId,
    projectDir,
    firstSeen,
    lastSeen,
    durationMs,
    totalTokens,
    rateLimitTokens,
    totalCalls: sessionCalls.length,
    primaryModel,
    teamName,
    agents: Array.from(agentSet),
    subagentSessions: [] as SessionSummary[],
  };

  // Check for subagent files
  const parentDir = matchingFiles[0].replace(/\/[^/]+\.jsonl$/, "");
  try {
    const { readdir: readdirAsync } = await import("node:fs/promises");
    const subagentDir = `${parentDir}/subagents`;
    const subFiles = await readdirAsync(subagentDir).catch(() => []);
    for (const sf of subFiles) {
      if (typeof sf === "string" && sf.endsWith(".jsonl")) {
        const subCalls = await parseSessionFile(`${subagentDir}/${sf}`);
        if (subCalls.length > 0) {
          const subTokens = subCalls.reduce((s, c) => s + c.totalTokens, 0);
          const subAgents = new Set(subCalls.map((c) => c.agentName).filter(Boolean));
          session.subagentSessions.push({
            sessionId: subCalls[0].sessionId,
            projectDir,
            firstSeen: subCalls[0].timestamp,
            lastSeen: subCalls[subCalls.length - 1].timestamp,
            durationMs: new Date(subCalls[subCalls.length - 1].timestamp).getTime() - new Date(subCalls[0].timestamp).getTime(),
            totalTokens: subTokens,
            rateLimitTokens: subCalls.reduce((s, c) => s + c.rateLimitTokens, 0),
            totalCalls: subCalls.length,
            primaryModel: subCalls[0].model,
            teamName: subCalls[0].teamName,
            agents: Array.from(subAgents) as string[],
            subagentSessions: [],
          });
        }
      }
    }
  } catch { /* no subagents */ }

  if (values.json) {
    console.log(JSON.stringify({ session, calls: sessionCalls }, null, 2));
    return;
  }

  // Session header
  console.log(`\n**Session Detail** — ${sessionId}\n`);
  console.log(`- **Project:** ${formatProjectDir(session.projectDir)}`);
  console.log(`- **Time Range:** ${formatTime(session.firstSeen)} → ${formatTime(session.lastSeen)}`);
  console.log(`- **Duration:** ${formatDuration(session.durationMs)}`);
  console.log(`- **Total Tokens:** ${formatTokens(session.totalTokens)}`);
  console.log(`- **Rate Limit Tokens:** ${formatTokens(session.rateLimitTokens)}`);
  console.log(`- **Model:** ${session.primaryModel}`);
  console.log(`- **API Calls:** ${session.totalCalls}`);
  if (session.teamName) {
    console.log(`- **Team:** ${session.teamName}`);
  }

  // Cache efficiency
  const totalInput = sessionCalls.reduce((sum, c) => sum + c.inputTokens + c.cacheReadTokens, 0);
  const totalCacheRead = sessionCalls.reduce((sum, c) => sum + c.cacheReadTokens, 0);
  const cacheEfficiency = totalInput > 0 ? totalCacheRead / totalInput : 0;
  console.log(`- **Cache Efficiency:** ${formatPercent(cacheEfficiency)} (cache_read / total_input)`);

  // API call table
  console.log(`\n**API Calls** (${sessionCalls.length} total)\n`);

  let runningTotal = 0;
  const headers = ["#", "Time", "Model", "Input", "Output", "Cache Read", "Cache Create", "Total", "Cumulative"];
  const rows = sessionCalls.map((c, i) => {
    runningTotal += c.totalTokens;
    return [
      String(i + 1),
      formatTime(c.timestamp),
      c.model.replace("claude-", ""),
      formatTokens(c.inputTokens),
      formatTokens(c.outputTokens),
      formatTokens(c.cacheReadTokens),
      formatTokens(c.cacheCreationTokens),
      formatTokens(c.totalTokens),
      formatTokens(runningTotal),
    ];
  });

  console.log(markdownTable(headers, rows));

  // Agent hierarchy for team sessions
  if (session.teamName && session.subagentSessions.length > 0) {
    console.log(`\n**Agent Hierarchy** (Team: ${session.teamName})\n`);

    // Main session agent
    const mainAgentTokens = sessionCalls
      .filter((c) => !c.agentName || session.agents.includes(c.agentName))
      .reduce((sum, c) => sum + c.totalTokens, 0);

    console.log(`├─ main: ${formatTokens(mainAgentTokens)} tokens`);

    for (let i = 0; i < session.subagentSessions.length; i++) {
      const sub = session.subagentSessions[i];
      const isLast = i === session.subagentSessions.length - 1;
      const prefix = isLast ? "└─" : "├─";
      const agentLabel = sub.agents[0] ?? truncateSessionId(sub.sessionId);
      console.log(
        `${prefix} ${agentLabel}: ${formatTokens(sub.totalTokens)} tokens, ` +
        `${sub.totalCalls} calls, ${sub.primaryModel.replace("claude-", "")}`
      );
    }
  }
}


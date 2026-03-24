import type { DiscoveredFile } from "./discovery.js";
import type { ApiCall } from "./parser.js";

export interface SessionSummary {
  sessionId: string;
  projectDir: string;
  firstSeen: string;
  lastSeen: string;
  durationMs: number;
  totalTokens: number;
  rateLimitTokens: number;
  totalCalls: number;
  primaryModel: string;
  teamName?: string;
  agents: string[];
  parentSessionId?: string;
  subagentSessions: SessionSummary[];
}

/**
 * URL-decode a project slug to recover the original directory path.
 * Claude Code encodes project directories as URL-encoded path segments.
 */
function decodeProjectDir(slug: string): string {
  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
}

/**
 * Find the most frequently occurring model in a list of API calls.
 */
function findPrimaryModel(calls: ApiCall[]): string {
  const counts = new Map<string, number>();
  for (const call of calls) {
    counts.set(call.model, (counts.get(call.model) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [model, count] of counts) {
    if (count > bestCount) {
      best = model;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Aggregate parsed API calls into session summaries.
 *
 * Groups calls by sessionId, computes per-session stats,
 * and nests subagent sessions under their parents.
 */
export function aggregateSessions(
  files: DiscoveredFile[],
  calls: Map<string, ApiCall[]>
): SessionSummary[] {
  // Build a map of file path → discovery metadata
  const fileMetaMap = new Map<string, DiscoveredFile>();
  for (const f of files) {
    fileMetaMap.set(f.path, f);
  }

  // Collect all calls grouped by sessionId, tracking per-file metadata
  const sessionCalls = new Map<string, ApiCall[]>();
  const sessionFiles = new Map<string, DiscoveredFile[]>();

  for (const [filePath, fileCalls] of calls) {
    const meta = fileMetaMap.get(filePath);
    for (const call of fileCalls) {
      const sid = call.sessionId;
      if (!sessionCalls.has(sid)) {
        sessionCalls.set(sid, []);
        sessionFiles.set(sid, []);
      }
      sessionCalls.get(sid)!.push(call);
      if (meta && !sessionFiles.get(sid)!.includes(meta)) {
        sessionFiles.get(sid)!.push(meta);
      }
    }
  }

  // Build summaries
  const summaries = new Map<string, SessionSummary>();
  const parentMap = new Map<string, string>(); // sessionId → parentSessionId

  for (const [sessionId, allCalls] of sessionCalls) {
    if (allCalls.length === 0) continue;

    // Sort by timestamp
    allCalls.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const firstSeen = allCalls[0].timestamp;
    const lastSeen = allCalls[allCalls.length - 1].timestamp;
    const durationMs = new Date(lastSeen).getTime() - new Date(firstSeen).getTime();

    let totalTokens = 0;
    let rateLimitTokens = 0;
    const agentSet = new Set<string>();
    let teamName: string | undefined;

    for (const call of allCalls) {
      totalTokens += call.totalTokens;
      rateLimitTokens += call.rateLimitTokens;
      if (call.agentName) agentSet.add(call.agentName);
      if (call.teamName && !teamName) teamName = call.teamName;
    }

    // Get project slug from any associated file
    const associatedFiles = sessionFiles.get(sessionId) ?? [];
    const projectSlug = associatedFiles[0]?.projectSlug ?? "unknown";
    const projectDir = decodeProjectDir(projectSlug);

    // Check if any associated file is a subagent file
    const subagentFile = associatedFiles.find((f) => f.isSubagent);
    if (subagentFile?.parentSessionId) {
      parentMap.set(sessionId, subagentFile.parentSessionId);
    }

    summaries.set(sessionId, {
      sessionId,
      projectDir,
      firstSeen,
      lastSeen,
      durationMs,
      totalTokens,
      rateLimitTokens,
      totalCalls: allCalls.length,
      primaryModel: findPrimaryModel(allCalls),
      teamName,
      agents: Array.from(agentSet),
      parentSessionId: subagentFile?.parentSessionId,
      subagentSessions: [],
    });
  }

  // Nest subagent sessions under parents
  for (const [childId, parentId] of parentMap) {
    const parent = summaries.get(parentId);
    const child = summaries.get(childId);
    if (parent && child && childId !== parentId) {
      parent.subagentSessions.push(child);
    }
  }

  // Return only top-level sessions (not subagents that have been nested)
  const subagentIds = new Set(parentMap.keys());
  const topLevel = Array.from(summaries.values()).filter(
    (s) => !subagentIds.has(s.sessionId)
  );

  // Sort by firstSeen descending (newest first)
  topLevel.sort((a, b) => b.firstSeen.localeCompare(a.firstSeen));

  return topLevel;
}

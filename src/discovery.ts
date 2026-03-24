import { readdir, stat } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";

export interface DiscoveredFile {
  path: string;
  mtime: Date;
  size: number;
  isSubagent: boolean;
  parentSessionId?: string;
  projectSlug: string;
}

export interface DiscoverOptions {
  since?: Date;
  until?: Date;
  basePath?: string;
}

const SUBAGENT_PATTERN = /\/subagents\/agent-[^/]+\.jsonl$/;
const SESSION_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Recursively find all .jsonl files under a directory.
 */
async function walkJsonl(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const children = await walkJsonl(fullPath);
      results.push(...children);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Extract the project slug from a file path.
 * Path format: <basePath>/<project-slug>/<session-uuid>.jsonl
 * or: <basePath>/<project-slug>/<session-uuid>/subagents/agent-<id>.jsonl
 */
function extractProjectSlug(filePath: string, basePath: string): string {
  const relative = filePath.slice(basePath.length + 1);
  const firstSlash = relative.indexOf("/");
  return firstSlash === -1 ? relative : relative.slice(0, firstSlash);
}

/**
 * Extract parent session ID from a subagent file path.
 * Path format: .../<session-uuid>/subagents/agent-<id>.jsonl
 */
function extractParentSessionId(filePath: string): string | undefined {
  const parts = filePath.split("/");
  const subagentsIdx = parts.indexOf("subagents");
  if (subagentsIdx > 0) {
    const candidate = parts[subagentsIdx - 1];
    if (SESSION_UUID_PATTERN.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Discover all JSONL session files under ~/.claude/projects/.
 * Filters by file mtime before reading content (performance optimization).
 */
export async function discoverFiles(options: DiscoverOptions = {}): Promise<DiscoveredFile[]> {
  const basePath = options.basePath ?? join(homedir(), ".claude", "projects");
  const files = await walkJsonl(basePath);

  const results: DiscoveredFile[] = [];

  // Process files in parallel for better I/O performance
  const statPromises = files.map(async (filePath) => {
    try {
      const fileStat = await stat(filePath);
      const mtime = fileStat.mtime;

      // Pre-filter by mtime before any further processing
      if (options.since && mtime < options.since) return null;
      if (options.until && mtime > options.until) return null;

      const isSubagent = SUBAGENT_PATTERN.test(filePath);

      return {
        path: filePath,
        mtime,
        size: fileStat.size,
        isSubagent,
        parentSessionId: isSubagent ? extractParentSessionId(filePath) : undefined,
        projectSlug: extractProjectSlug(filePath, basePath),
      } satisfies DiscoveredFile;
    } catch {
      // File may have been deleted between readdir and stat
      return null;
    }
  });

  const settled = await Promise.all(statPromises);
  for (const result of settled) {
    if (result !== null) {
      results.push(result);
    }
  }

  return results;
}

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Raw JSONL entry structure as written by Claude Code.
 */
export interface RawJsonlEntry {
  type: string;
  timestamp: string;
  sessionId: string;
  uuid?: string;
  parentUuid?: string;
  isSidechain?: boolean;
  teamName?: string;
  agentName?: string;
  agentId?: string;
  requestId?: string;
  version?: string;
  message?: {
    id: string;
    model: string;
    stop_reason: string | null;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_creation?: {
        ephemeral_1h_input_tokens?: number;
        ephemeral_5m_input_tokens?: number;
      };
    };
  };
}

/**
 * Parsed API call with extracted and computed fields.
 */
export interface ApiCall {
  messageId: string;
  sessionId: string;
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  rateLimitTokens: number;
  teamName?: string;
  agentName?: string;
  sourceVersion?: string;
}

/**
 * Derive an agent name from a file path when agentName/agentId are absent.
 * Extracts from pattern: .../subagents/agent-<name>.jsonl
 */
function deriveAgentFromPath(filePath: string): string | undefined {
  const match = filePath.match(/agent-([^/]+)\.jsonl$/);
  return match ? match[1] : undefined;
}

/**
 * Parse a single JSONL session file, extracting API call data.
 *
 * - Reads line-by-line (streaming for large files)
 * - Filters to type=assistant with non-null stop_reason
 * - Deduplicates by message.id (keeps entry with non-null stop_reason)
 * - Extracts all token fields
 */
export async function parseSessionFile(filePath: string): Promise<ApiCall[]> {
  const seen = new Map<string, ApiCall>();

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;

    let entry: RawJsonlEntry;
    try {
      entry = JSON.parse(line);
    } catch {
      // Malformed line — skip and continue
      continue;
    }

    // Only process assistant entries
    if (entry.type !== "assistant") continue;

    // Must have a message with usage data
    if (!entry.message?.usage) continue;

    // Only keep entries with non-null stop_reason (final streaming entry)
    if (entry.message.stop_reason === null || entry.message.stop_reason === undefined) continue;

    const messageId = entry.message.id;
    if (!messageId) continue;

    // Dedup: if we've already seen this message.id, keep the one with stop_reason
    // Since we only let non-null stop_reason through, this is the authoritative entry
    const usage = entry.message.usage;
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
    const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
    const rateLimitTokens = totalTokens - cacheReadTokens;

    const agentName = entry.agentName ?? entry.agentId ?? deriveAgentFromPath(filePath);

    const call: ApiCall = {
      messageId,
      sessionId: entry.sessionId,
      timestamp: entry.timestamp,
      model: entry.message.model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalTokens,
      rateLimitTokens,
      teamName: entry.teamName,
      agentName,
      sourceVersion: entry.version,
    };

    // Dedup by message.id — last one wins (should only be one with stop_reason)
    seen.set(messageId, call);
  }

  return Array.from(seen.values());
}

/**
 * SQL query functions that mirror the JSONL-based pipeline.
 * Returns the same data shapes so command output formatting stays identical.
 */
import type Database from "better-sqlite3";
import type { SessionSummary } from "../aggregator.js";
import type { ApiCall } from "../parser.js";

interface TimeFilter {
  since?: Date;
  until?: Date;
}

function buildWhereClause(table: string, filter: TimeFilter): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const tsCol = table === "sessions" ? "first_seen" : "timestamp";

  if (filter.since) {
    conditions.push(`${tsCol} >= ?`);
    params.push(filter.since.toISOString());
  }
  if (filter.until) {
    conditions.push(`${tsCol} <= ?`);
    params.push(filter.until.toISOString());
  }

  const clause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  return { clause, params };
}

export function querySessions(db: Database.Database, filter: TimeFilter): SessionSummary[] {
  const { clause, params } = buildWhereClause("sessions", filter);
  const rows = db
    .prepare(
      `SELECT session_id, first_seen, last_seen, total_tokens, rate_limit_tokens,
              total_calls, primary_model, team_name, agent_name, parent_session_id, project_dir
       FROM sessions ${clause}
       ORDER BY first_seen DESC`
    )
    .all(...params) as Array<{
    session_id: string;
    first_seen: string;
    last_seen: string;
    total_tokens: number;
    rate_limit_tokens: number;
    total_calls: number;
    primary_model: string;
    team_name: string | null;
    agent_name: string | null;
    parent_session_id: string | null;
    project_dir: string | null;
  }>;

  return rows.map((r) => ({
    sessionId: r.session_id,
    projectDir: r.project_dir ?? "unknown",
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
    durationMs: new Date(r.last_seen).getTime() - new Date(r.first_seen).getTime(),
    totalTokens: r.total_tokens,
    rateLimitTokens: r.rate_limit_tokens,
    totalCalls: r.total_calls,
    primaryModel: r.primary_model ?? "",
    teamName: r.team_name ?? undefined,
    agents: r.agent_name ? [r.agent_name] : [],
    parentSessionId: r.parent_session_id ?? undefined,
    subagentSessions: [],
  }));
}

export function querySessionCalls(db: Database.Database, sessionId: string): ApiCall[] {
  const rows = db
    .prepare(
      `SELECT message_id, session_id, timestamp, model,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
              total_tokens, rate_limit_tokens, team_name, agent_name, source_version
       FROM api_calls WHERE session_id = ? ORDER BY timestamp`
    )
    .all(sessionId) as Array<{
    message_id: string;
    session_id: string;
    timestamp: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    total_tokens: number;
    rate_limit_tokens: number;
    team_name: string | null;
    agent_name: string | null;
    source_version: string | null;
  }>;

  return rows.map((r) => ({
    messageId: r.message_id,
    sessionId: r.session_id,
    timestamp: r.timestamp,
    model: r.model ?? "",
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    totalTokens: r.total_tokens,
    rateLimitTokens: r.rate_limit_tokens,
    teamName: r.team_name ?? undefined,
    agentName: r.agent_name ?? undefined,
    sourceVersion: r.source_version ?? undefined,
  }));
}

export function queryApiCalls(db: Database.Database, filter: TimeFilter): ApiCall[] {
  const { clause, params } = buildWhereClause("api_calls", filter);
  const rows = db
    .prepare(
      `SELECT message_id, session_id, timestamp, model,
              input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
              total_tokens, rate_limit_tokens, team_name, agent_name, source_version
       FROM api_calls ${clause} ORDER BY timestamp`
    )
    .all(...params) as Array<{
    message_id: string;
    session_id: string;
    timestamp: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    total_tokens: number;
    rate_limit_tokens: number;
    team_name: string | null;
    agent_name: string | null;
    source_version: string | null;
  }>;

  return rows.map((r) => ({
    messageId: r.message_id,
    sessionId: r.session_id,
    timestamp: r.timestamp,
    model: r.model ?? "",
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cacheReadTokens: r.cache_read_tokens,
    cacheCreationTokens: r.cache_creation_tokens,
    totalTokens: r.total_tokens,
    rateLimitTokens: r.rate_limit_tokens,
    teamName: r.team_name ?? undefined,
    agentName: r.agent_name ?? undefined,
    sourceVersion: r.source_version ?? undefined,
  }));
}

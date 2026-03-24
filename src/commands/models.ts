import { parseArgs } from "node:util";
import { discoverFiles } from "../discovery.js";
import { parseSessionFile } from "../parser.js";
import { parseTimeValue } from "../time.js";
import {
  formatTokens,
  formatPercent,
  markdownTable,
} from "../formatter.js";
import { openDatabase, closeDatabase } from "../db/connection.js";
import { queryApiCalls } from "../db/queries.js";
import type { ApiCall } from "../parser.js";

function printHelp(): void {
  console.log(`
cc-analytics models — Token distribution by model

Usage:
  cc-analytics models [options]

Options:
  --since <value>   Start of time window (ISO date, relative: 24h/7d, or: today/yesterday)
  --until <value>   End of time window (same formats as --since)
  --json            Output as JSON instead of markdown
  --help, -h        Show this help message

Examples:
  cc-analytics models --since today
  cc-analytics models --since 7d
  cc-analytics models --since 7d --json
`);
}

interface ModelStats {
  model: string;
  totalTokens: number;
  callCount: number;
  avgTokensPerCall: number;
  percentOfTotal: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export async function runModels(args: string[], useDb = false): Promise<void> {
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

  let allCalls: ApiCall[];
  if (useDb) {
    const db = openDatabase();
    allCalls = queryApiCalls(db, { since, until });
    closeDatabase();
  } else {
    const files = await discoverFiles({ since, until });
    if (files.length === 0) {
      console.log("No JSONL files found in the specified time window.");
      return;
    }

    allCalls = [];
    for (const file of files) {
      try {
        const calls = await parseSessionFile(file.path);
        allCalls.push(...calls);
      } catch { /* skip */ }
    }
  }

  if (allCalls.length === 0) {
    console.log("No API calls found.");
    return;
  }

  // Aggregate by model
  const modelMap = new Map<string, { totalTokens: number; callCount: number; inputTokens: number; outputTokens: number; cacheReadTokens: number }>();

  for (const call of allCalls) {
    if (!modelMap.has(call.model)) {
      modelMap.set(call.model, { totalTokens: 0, callCount: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    }
    const entry = modelMap.get(call.model)!;
    entry.totalTokens += call.totalTokens;
    entry.callCount += 1;
    entry.inputTokens += call.inputTokens;
    entry.outputTokens += call.outputTokens;
    entry.cacheReadTokens += call.cacheReadTokens;
  }

  const grandTotal = allCalls.reduce((sum, c) => sum + c.totalTokens, 0);

  const models: ModelStats[] = Array.from(modelMap.entries())
    .map(([model, data]) => ({
      model,
      totalTokens: data.totalTokens,
      callCount: data.callCount,
      avgTokensPerCall: data.callCount > 0 ? Math.round(data.totalTokens / data.callCount) : 0,
      percentOfTotal: grandTotal > 0 ? data.totalTokens / grandTotal : 0,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      cacheReadTokens: data.cacheReadTokens,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  if (values.json) {
    console.log(JSON.stringify({ models, summary: { grandTotal, totalCalls: allCalls.length } }, null, 2));
    return;
  }

  console.log(`\n**Model Breakdown** — ${formatTokens(grandTotal)} total tokens, ${allCalls.length} API calls\n`);

  const headers = ["Model", "Total Tokens", "% of Total", "Calls", "Avg/Call", "Input", "Output", "Cache Read"];
  const rows = models.map((m) => [
    m.model.replace("claude-", ""),
    formatTokens(m.totalTokens),
    formatPercent(m.percentOfTotal),
    String(m.callCount),
    formatTokens(m.avgTokensPerCall),
    formatTokens(m.inputTokens),
    formatTokens(m.outputTokens),
    formatTokens(m.cacheReadTokens),
  ]);

  console.log(markdownTable(headers, rows));
}

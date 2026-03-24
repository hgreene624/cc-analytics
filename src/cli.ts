#!/usr/bin/env node

import { parseArgs } from "node:util";

const COMMANDS = ["scan", "top", "detail", "compare", "budget", "trend", "models", "teams", "projects", "cache", "anomalies", "import"] as const;
type Command = (typeof COMMANDS)[number];

function printUsage(): void {
  console.log(`
cc-analytics — Forensic auditing toolkit for Claude Code token consumption

Usage:
  cc-analytics <command> [options]

Commands:
  scan        Build session inventory from JSONL files
  top         Top N sessions by token usage
  detail      Drill into a single session
  compare     Compare two time periods
  budget      Rolling window analysis
  trend       Daily trend with averages
  models      Model breakdown
  teams       Team analysis
  projects    Project directory analysis
  cache       Cache efficiency report
  anomalies   Flag outlier sessions
  import      Import JSONL to SQLite (optional)

Global Options:
  --db          Query SQLite database instead of parsing JSONL
  --help, -h    Show this help message
  --version     Show version

Run 'cc-analytics <command> --help' for command-specific options.
`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    printUsage();
    process.exit(0);
  }

  if (args[0] === "--version") {
    console.log("cc-analytics v0.1.0");
    process.exit(0);
  }

  const command = args[0] as string;

  if (!COMMANDS.includes(command as Command)) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  // Extract --db flag before passing remaining args to commands
  const commandArgs = args.slice(1);
  const dbFlagIndex = commandArgs.indexOf("--db");
  const useDb = dbFlagIndex !== -1;
  if (useDb) {
    commandArgs.splice(dbFlagIndex, 1);
  }

  switch (command) {
    case "scan": {
      const { runScan } = await import("./commands/scan.js");
      await runScan(commandArgs, useDb);
      break;
    }
    case "top": {
      const { runTop } = await import("./commands/top.js");
      await runTop(commandArgs, useDb);
      break;
    }
    case "detail": {
      const { runDetail } = await import("./commands/detail.js");
      await runDetail(commandArgs, useDb);
      break;
    }
    case "budget": {
      const { runBudget } = await import("./commands/budget.js");
      await runBudget(commandArgs, useDb);
      break;
    }
    case "trend": {
      const { runTrend } = await import("./commands/trend.js");
      await runTrend(commandArgs, useDb);
      break;
    }
    case "compare": {
      const { runCompare } = await import("./commands/compare.js");
      await runCompare(commandArgs, useDb);
      break;
    }
    case "anomalies": {
      const { runAnomalies } = await import("./commands/anomalies.js");
      await runAnomalies(commandArgs, useDb);
      break;
    }
    case "models": {
      const { runModels } = await import("./commands/models.js");
      await runModels(commandArgs, useDb);
      break;
    }
    case "teams": {
      const { runTeams } = await import("./commands/teams.js");
      await runTeams(commandArgs, useDb);
      break;
    }
    case "projects": {
      const { runProjects } = await import("./commands/projects.js");
      await runProjects(commandArgs, useDb);
      break;
    }
    case "cache": {
      const { runCache } = await import("./commands/cache.js");
      await runCache(commandArgs, useDb);
      break;
    }
    case "import": {
      const { runImport } = await import("./commands/import.js");
      await runImport(commandArgs);
      break;
    }
    default:
      console.error(`Command '${command}' is not yet implemented.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});

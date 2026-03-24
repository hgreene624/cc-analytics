#!/usr/bin/env node

import { parseArgs } from "node:util";

const COMMANDS = ["scan", "top", "detail", "compare", "budget", "trend", "models", "teams", "projects", "cache", "anomalies", "audit", "import"] as const;
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
  audit       Full comprehensive audit
  import      Import JSONL to SQLite (optional)

Global Options:
  --help, -h  Show this help message
  --version   Show version

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

  switch (command) {
    case "scan": {
      const { runScan } = await import("./commands/scan.js");
      await runScan(args.slice(1));
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

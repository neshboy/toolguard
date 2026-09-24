#!/usr/bin/env node
/**
 * Minimal CLI for piping raw (typically local-model) completions through
 * ToolGuard for manual testing:
 *
 *   echo '{"name":"get_weather","arguments":{"location":"Paris",}}' \
 *     | toolguard --schema examples/get-weather.tool.json
 *
 * Prints the full RepairResult as JSON to stdout and exits 0 if the call
 * was accepted, 1 if it was rejected, 2 on a usage error.
 */
import { readFileSync } from "node:fs";
import { repairToolCall } from "./repairToolCall.js";
import type { ToolDefinition } from "./types.js";

function printUsage(): void {
  console.error(
    [
      "toolguard - repair and validate a raw LLM tool-call against a JSON Schema tool definition",
      "",
      "Usage:",
      "  toolguard --schema <tool-definition.json> [--input <file>]",
      "  <raw model output> | toolguard --schema <tool-definition.json>",
      "",
      'The schema file must be a JSON object: { "name": "...", "parameters": { ...JSON Schema... } }',
      "If --input is omitted, raw output is read from stdin.",
      "",
      "Exit code 0 = tool call accepted, 1 = rejected, 2 = usage error."
    ].join("\n")
  );
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let schemaPath: string | undefined;
  let inputPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--schema" || arg === "-s") {
      schemaPath = args[++i];
    } else if (arg === "--input" || arg === "-i") {
      inputPath = args[++i];
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      return 0;
    }
  }

  if (!schemaPath) {
    printUsage();
    return 2;
  }

  let tool: ToolDefinition;
  try {
    const schemaText = readFileSync(schemaPath, "utf8");
    tool = JSON.parse(schemaText) as ToolDefinition;
  } catch (err) {
    console.error(`Failed to read/parse schema file "${schemaPath}": ${(err as Error).message}`);
    return 2;
  }

  const rawOutput = inputPath ? readFileSync(inputPath, "utf8") : await readStdin();

  const result = repairToolCall(rawOutput, tool);
  console.log(JSON.stringify(result, null, 2));
  return result.ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });

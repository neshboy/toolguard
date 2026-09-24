import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { repairToolCall } from "../src/repairToolCall.js";
import type { ToolDefinition } from "../src/types.js";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const weatherTool: ToolDefinition = {
  name: "get_weather",
  description: "Get the current weather for a location.",
  parameters: {
    type: "object",
    properties: {
      location: { type: "string" },
      unit: { type: "string", enum: ["celsius", "fahrenheit"] },
      days: { type: "integer", minimum: 1, maximum: 14 }
    },
    required: ["location"],
    additionalProperties: false
  }
};

describe("integration: end-to-end raw model output -> validated tool call", () => {
  it("extracts JSON out of markdown-fenced prose, repairs a trailing comma, and validates", () => {
    const rawModelOutput = [
      "Sure, let me check that for you.",
      "",
      "```json",
      '{"name": "get_weather", "arguments": {"location": "Paris", "unit": "celsius",}}',
      "```",
      "",
      "Let me know if you need anything else!"
    ].join("\n");

    const result = repairToolCall(rawModelOutput, weatherTool);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.toolCall).toEqual({
        name: "get_weather",
        arguments: { location: "Paris", unit: "celsius" }
      });
      expect(result.repairsApplied).toEqual(["trailing-comma-repair"]);
    }
  });

  it("repairs a real multi-fault case: generation cut off mid-object AND a stringified numeric argument", () => {
    // Realistic combination: a small model hits its token limit partway
    // through the call (truncation) and also quoted an integer argument
    // (type coercion needed) in the same completion.
    const rawModelOutput =
      '{"name": "get_weather", "arguments": {"location": "Paris", "days": "3",';

    const result = repairToolCall(rawModelOutput, weatherTool);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.toolCall).toEqual({
        name: "get_weather",
        arguments: { location: "Paris", days: 3 }
      });
      expect(result.repairsApplied.sort()).toEqual(["truncation-repair", "type-coercion"].sort());
      expect(result.coercions).toEqual([
        { path: "$.days", from: "3", to: 3, rule: "numeric-string-to-integer" }
      ]);
    }
  });

  it("accepts the bare-arguments form some local models emit (no {name, arguments} envelope)", () => {
    const result = repairToolCall('{"location": "Tokyo", "unit": "celsius"}', weatherTool);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.toolCall).toEqual({
        name: "get_weather",
        arguments: { location: "Tokyo", unit: "celsius" }
      });
      expect(result.repairsApplied).toEqual([]);
    }
  });

  it("repairs a double-encoded (OpenAI-style stringified) arguments field that itself has a trailing comma", () => {
    const rawModelOutput = '{"name": "get_weather", "arguments": "{\\"location\\": \\"Rome\\",}"}';
    const result = repairToolCall(rawModelOutput, weatherTool);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.toolCall).toEqual({ name: "get_weather", arguments: { location: "Rome" } });
      expect(result.repairsApplied).toEqual(["trailing-comma-repair"]);
    }
  });

  it("CLI: pipes malformed raw output through `toolguard` and exits 0 with the repaired call", () => {
    const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const schemaPath = path.join(projectRoot, "examples", "get-weather.tool.json");
    const cliEntry = path.join(projectRoot, "src", "cli.ts");

    const proc = spawnSync(
      process.execPath,
      [tsxCli, cliEntry, "--schema", schemaPath],
      {
        input: '{"name": "get_weather", "arguments": {"location": "Berlin", "unit": "celsius",}}',
        encoding: "utf8",
        cwd: projectRoot
      }
    );

    expect(proc.status).toBe(0);
    const output = JSON.parse(proc.stdout);
    expect(output.ok).toBe(true);
    expect(output.toolCall).toEqual({
      name: "get_weather",
      arguments: { location: "Berlin", unit: "celsius" }
    });
  });

  it("CLI: exits 1 and reports a structured rejection for a hallucinated tool name", () => {
    const tsxCli = path.join(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const schemaPath = path.join(projectRoot, "examples", "get-weather.tool.json");
    const cliEntry = path.join(projectRoot, "src", "cli.ts");

    const proc = spawnSync(
      process.execPath,
      [tsxCli, cliEntry, "--schema", schemaPath],
      {
        input: '{"name": "get_wether", "arguments": {"location": "Berlin"}}',
        encoding: "utf8",
        cwd: projectRoot
      }
    );

    expect(proc.status).toBe(1);
    const output = JSON.parse(proc.stdout);
    expect(output.ok).toBe(false);
    expect(output.reason).toBe("tool_name_mismatch");
  });
});

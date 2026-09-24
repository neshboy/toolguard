import { describe, expect, it } from "vitest";
import { repairToolCall, repairToolCallAmong } from "../src/repairToolCall.js";
import type { ToolDefinition } from "../src/types.js";

const weatherTool: ToolDefinition = {
  name: "get_weather",
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

describe("repairToolCall rejection reasons", () => {
  it("reason: empty_input", () => {
    const result = repairToolCall("   ", weatherTool);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty_input");
  });

  it("reason: no_json_found", () => {
    const result = repairToolCall("I refuse to call any tool right now.", weatherTool);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_json_found");
  });

  it("reason: unrepairable_json (malformation outside the documented repair set: a missing comma between members)", () => {
    const result = repairToolCall(
      '{"name": "get_weather" "arguments": {"location": "Paris"}}',
      weatherTool
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unrepairable_json");
      expect(result.attemptedRepairs).toEqual([
        "unescaped-quote-repair",
        "trailing-comma-repair",
        "truncation-repair"
      ]);
      expect(result.message).toMatch(/parse error/i);
    }
  });

  it("reason: unrepairable_json for structurally nonsensical input even after brace-balancing", () => {
    // "{{{" balances to "{{{}}}" which is still not valid JSON (an object
    // can't open directly into another object without a key), so this
    // must be rejected rather than silently forwarded.
    const result = repairToolCall("{{{", weatherTool);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unrepairable_json");
      expect(result.bestEffortText).toBe("{{{}}}");
    }
  });

  it("reason: unrepairable_arguments_json when a double-encoded arguments string can't be repaired", () => {
    const result = repairToolCall(
      '{"name": "get_weather", "arguments": "{\\"location\\" \\"Paris\\"}"}',
      weatherTool
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unrepairable_arguments_json");
  });

  it("reason: arguments_not_object when arguments is an array", () => {
    const result = repairToolCall('{"name": "get_weather", "arguments": [1,2,3]}', weatherTool);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("arguments_not_object");
      expect(result.message).toMatch(/array/);
    }
  });

  it("reason: tool_name_mismatch on a hallucinated/close-but-wrong tool name", () => {
    const result = repairToolCall(
      '{"name": "get_wather", "arguments": {"location": "Paris"}}',
      weatherTool
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("tool_name_mismatch");
      expect(result.message).toMatch(/get_wather/);
      expect(result.message).toMatch(/get_weather/);
    }
  });

  it("reason: schema_validation_failed when repair succeeds syntactically but the value is still invalid", () => {
    // Truncated mid-value: closing the string leaves "unit" as "cel", which
    // is syntactically valid JSON but not one of the declared enum values.
    const result = repairToolCall(
      '{"name": "get_weather", "arguments": {"location": "Paris", "unit": "cel',
      weatherTool
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema_validation_failed");
      expect(result.validationErrors?.join(" ")).toMatch(/allowed values/);
    }
  });

  it("repairToolCallAmong reports a hallucinated name against the full declared tool set", () => {
    const result = repairToolCallAmong('{"name": "delete_everything", "arguments": {}}', [weatherTool]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("tool_name_mismatch");
      expect(result.message).toMatch(/delete_everything/);
      expect(result.message).toMatch(/get_weather/);
    }
  });
});

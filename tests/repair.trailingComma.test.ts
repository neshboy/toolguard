import { describe, expect, it } from "vitest";
import { repairTrailingCommas } from "../src/repair/trailingComma.js";

describe("repairTrailingCommas (strategy a)", () => {
  it("removes a trailing comma before a closing object brace", () => {
    const result = repairTrailingCommas('{"a": 1, "b": 2,}');
    expect(result).toEqual({ text: '{"a": 1, "b": 2}', changed: true });
  });

  it("removes a trailing comma before a closing array bracket", () => {
    const result = repairTrailingCommas('{"items": [1, 2, 3,]}');
    expect(result).toEqual({ text: '{"items": [1, 2, 3]}', changed: true });
  });

  it("removes a trailing comma across newlines/whitespace before the brace", () => {
    const input = '{\n  "a": 1,\n  "b": 2,\n}';
    const result = repairTrailingCommas(input);
    expect(result.text).toBe('{\n  "a": 1,\n  "b": 2\n}');
    expect(result.changed).toBe(true);
  });

  it("removes multiple trailing commas in one pass", () => {
    const input = '{"a": [1,], "b": {"c": 2,},}';
    const result = repairTrailingCommas(input);
    expect(result.text).toBe('{"a": [1], "b": {"c": 2}}');
    expect(result.changed).toBe(true);
  });

  it("does NOT touch a literal comma-brace sequence inside a string value", () => {
    const input = '{"a": "a,}b"}';
    const result = repairTrailingCommas(input);
    expect(result).toEqual({ text: '{"a": "a,}b"}', changed: false });
  });

  it("is a no-op on already-valid JSON", () => {
    const input = '{"a": 1, "b": [1, 2, 3]}';
    const result = repairTrailingCommas(input);
    expect(result).toEqual({ text: input, changed: false });
  });
});

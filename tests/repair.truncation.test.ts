import { describe, expect, it } from "vitest";
import { repairTruncation } from "../src/repair/truncation.js";

describe("repairTruncation (strategy b)", () => {
  it("closes an unterminated string and the open braces around it", () => {
    const input = '{"name": "get_weather", "arguments": {"location": "Par';
    const result = repairTruncation(input);
    expect(result).toEqual({
      text: '{"name": "get_weather", "arguments": {"location": "Par"}}',
      changed: true
    });
  });

  it("drops a dangling trailing comma at end-of-input before closing", () => {
    const input = '{"a": 1, "b": 2,';
    const result = repairTruncation(input);
    expect(result).toEqual({ text: '{"a": 1, "b": 2}', changed: true });
  });

  it("removes a dangling key with no value at all, rather than inventing one", () => {
    const input = '{"a": 1, "b":';
    const result = repairTruncation(input);
    expect(result).toEqual({ text: '{"a": 1}', changed: true });
  });

  it("completes an unambiguous truncated bare literal (true/false/null)", () => {
    expect(repairTruncation('{"available": tru')).toEqual({
      text: '{"available": true}',
      changed: true
    });
    expect(repairTruncation('{"missing": nul')).toEqual({
      text: '{"missing": null}',
      changed: true
    });
    expect(repairTruncation('{"ok": fals')).toEqual({
      text: '{"ok": false}',
      changed: true
    });
  });

  it("closes a dangling nested object left empty by truncation, without inventing content", () => {
    const input = '{"a": 1, "b": {';
    const result = repairTruncation(input);
    expect(result).toEqual({ text: '{"a": 1, "b": {}}', changed: true });
  });

  it("removes a dangling object key truncated before any colon/value, rather than leaving a bare-key object", () => {
    const input = '{"loc';
    const result = repairTruncation(input);
    expect(result).toEqual({ text: "{}", changed: true });
    expect(() => JSON.parse(result.text)).not.toThrow();
  });

  it("removes a dangling object key (not the first member) truncated before any colon/value", () => {
    const input = '{"a": 1, "loc';
    const result = repairTruncation(input);
    expect(result).toEqual({ text: '{"a": 1}', changed: true });
  });

  it("removes a dangling object key truncated before colon/value inside a nested object", () => {
    const input = '{"a": {"loc';
    const result = repairTruncation(input);
    expect(result).toEqual({ text: '{"a": {}}', changed: true });
  });

  it("still closes a dangling string that is an array element (value position, not a key)", () => {
    const input = '["loc';
    const result = repairTruncation(input);
    expect(result).toEqual({ text: '["loc"]', changed: true });
  });

  it("removes an incomplete trailing number rather than guessing its digits", () => {
    const input = '{"a": 1, "score": 12.';
    const result = repairTruncation(input);
    expect(result).toEqual({ text: '{"a": 1}', changed: true });
  });

  it("balances multiple nested unclosed containers", () => {
    const input = '{"a": [1, 2, {"b": 3';
    const result = repairTruncation(input);
    expect(result).toEqual({ text: '{"a": [1, 2, {"b": 3}]}', changed: true });
  });

  it("is a no-op on already-valid, fully-closed JSON", () => {
    const input = '{"a": 1, "b": {"c": 2}}';
    const result = repairTruncation(input);
    expect(result).toEqual({ text: input, changed: false });
  });

  it("drops a lone dangling escape backslash before closing an unterminated string", () => {
    // The model was cut off mid-escape-sequence: `...caf\` with no char after
    // the backslash yet. Appending a bare `"` would let the backslash
    // swallow it, so the dangling backslash must be dropped first.
    const input = '{"name": "caf\\';
    const result = repairTruncation(input);
    expect(result).toEqual({ text: '{"name": "caf"}', changed: true });
  });
});

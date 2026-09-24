import { describe, expect, it } from "vitest";
import { repairUnescapedQuotes } from "../src/repair/unescapedQuotes.js";

describe("repairUnescapedQuotes (strategy c)", () => {
  it("escapes an unescaped inner quote inside a string value", () => {
    const input = '{"query": "find "cats" videos"}';
    const result = repairUnescapedQuotes(input);
    expect(result).toEqual({
      text: '{"query": "find \\"cats\\" videos"}',
      changed: true
    });
    // The repaired text must now be genuinely parseable.
    expect(JSON.parse(result.text)).toEqual({ query: 'find "cats" videos' });
  });

  it("handles multiple unescaped quotes within the same string", () => {
    const input = '{"message": "She said "hi" then "bye" quickly"}';
    const result = repairUnescapedQuotes(input);
    expect(JSON.parse(result.text)).toEqual({
      message: 'She said "hi" then "bye" quickly'
    });
    expect(result.changed).toBe(true);
  });

  it("leaves already-escaped quotes untouched", () => {
    const input = '{"message": "She said \\"hi\\" politely"}';
    const result = repairUnescapedQuotes(input);
    expect(result).toEqual({ text: input, changed: false });
  });

  it("is a no-op on already-valid JSON with no quotes inside string values", () => {
    const input = '{"a": "plain string", "b": 2}';
    const result = repairUnescapedQuotes(input);
    expect(result).toEqual({ text: input, changed: false });
  });

  it("documented limitation: a real closing quote immediately followed by another quoted token can be misclassified", () => {
    // This is the known, documented trade-off: the heuristic cannot tell
    // "string legitimately ends here, next token happens to start with a
    // quote too" apart from "this quote is an unescaped inner quote". The
    // point of this test is to pin down that documented behaviour, not to
    // claim it is correct in every case.
    const input = '{"name": "get_weather" "arguments": {"location": "Paris"}}';
    const result = repairUnescapedQuotes(input);
    expect(result.changed).toBe(true);
    expect(result.text).toBe('{"name": "get_weather\\" \\"arguments": {"location": "Paris"}}');
  });
});

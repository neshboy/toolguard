import { describe, expect, it } from "vitest";
import { coerceTypes } from "../src/repair/typeCoercion.js";
import type { JSONSchemaObject } from "../src/types.js";

describe("coerceTypes (strategy d)", () => {
  it("coerces a numeric string to a number when the schema expects number", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: { count: { type: "number" } }
    };
    const result = coerceTypes({ count: "42" }, schema);
    expect(result.value).toEqual({ count: 42 });
    expect(result.coercions).toEqual([
      { path: "$.count", from: "42", to: 42, rule: "numeric-string-to-number" }
    ]);
  });

  it("coerces a numeric string to an integer when the schema expects integer", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: { limit: { type: "integer" } }
    };
    const result = coerceTypes({ limit: "5" }, schema);
    expect(result.value).toEqual({ limit: 5 });
    expect(result.coercions).toEqual([
      { path: "$.limit", from: "5", to: 5, rule: "numeric-string-to-integer" }
    ]);
  });

  it("coerces the exact strings 'true'/'false' to booleans", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: { enabled: { type: "boolean" } }
    };
    const result = coerceTypes({ enabled: "false" }, schema);
    expect(result.value).toEqual({ enabled: false });
    expect(result.coercions).toEqual([
      { path: "$.enabled", from: "false", to: false, rule: "boolean-string-to-boolean" }
    ]);
  });

  it("recurses into nested objects and arrays", () => {
    const schema: JSONSchemaObject = {
      type: "object",
      properties: {
        location: {
          type: "object",
          properties: { lat: { type: "number" }, lon: { type: "number" } }
        },
        readings: { type: "array", items: { type: "number" } }
      }
    };
    const result = coerceTypes(
      { location: { lat: "48.85", lon: "2.35" }, readings: ["1", "2", "3"] },
      schema
    );
    expect(result.value).toEqual({
      location: { lat: 48.85, lon: 2.35 },
      readings: [1, 2, 3]
    });
    expect(result.coercions).toHaveLength(5);
  });

  it("does NOT coerce an ambiguous leading-zero numeric string (e.g. a code, not a number)", () => {
    const schema: JSONSchemaObject = { type: "object", properties: { id: { type: "integer" } } };
    const result = coerceTypes({ id: "007" }, schema);
    expect(result.value).toEqual({ id: "007" });
    expect(result.coercions).toEqual([]);
  });

  it("does NOT coerce a decimal string into an integer field", () => {
    const schema: JSONSchemaObject = { type: "object", properties: { count: { type: "integer" } } };
    const result = coerceTypes({ count: "5.5" }, schema);
    expect(result.value).toEqual({ count: "5.5" });
    expect(result.coercions).toEqual([]);
  });

  it("does NOT coerce a numeric string with surrounding whitespace", () => {
    const schema: JSONSchemaObject = { type: "object", properties: { count: { type: "number" } } };
    const result = coerceTypes({ count: " 5" }, schema);
    expect(result.value).toEqual({ count: " 5" });
    expect(result.coercions).toEqual([]);
  });

  it("does NOT coerce non-JSON-literal boolean spellings", () => {
    const schema: JSONSchemaObject = { type: "object", properties: { ok: { type: "boolean" } } };
    const result = coerceTypes({ ok: "True" }, schema);
    expect(result.value).toEqual({ ok: "True" });
    expect(result.coercions).toEqual([]);
  });

  it("leaves a value alone if it already satisfies the schema's type", () => {
    const schema: JSONSchemaObject = { type: "object", properties: { count: { type: "number" } } };
    const result = coerceTypes({ count: 42 }, schema);
    expect(result.value).toEqual({ count: 42 });
    expect(result.coercions).toEqual([]);
  });
});

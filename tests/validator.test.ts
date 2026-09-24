import { describe, expect, it } from "vitest";
import { validateArguments } from "../src/validator.js";
import type { JSONSchemaObject } from "../src/types.js";

const weatherParams: JSONSchemaObject = {
  type: "object",
  properties: {
    location: { type: "string" },
    unit: { type: "string", enum: ["celsius", "fahrenheit"] },
    days: { type: "integer", minimum: 1, maximum: 14 }
  },
  required: ["location"],
  additionalProperties: false
};

describe("validateArguments (real JSON Schema validation via ajv)", () => {
  it("accepts a minimal valid call", () => {
    const result = validateArguments({ location: "Paris" }, weatherParams);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("accepts a fully-populated valid call", () => {
    const result = validateArguments({ location: "Tokyo", unit: "celsius", days: 5 }, weatherParams);
    expect(result.valid).toBe(true);
  });

  it("rejects a call missing a required property", () => {
    const result = validateArguments({ unit: "celsius" }, weatherParams);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/location/);
  });

  it("rejects a wrong-typed property (number where string expected)", () => {
    const result = validateArguments({ location: 42 }, weatherParams);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/must be string/);
  });

  it("rejects a value outside the declared enum", () => {
    const result = validateArguments({ location: "Paris", unit: "kelvin" }, weatherParams);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/allowed values/);
  });

  it("rejects a value outside the declared numeric range", () => {
    const result = validateArguments({ location: "Paris", days: 30 }, weatherParams);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/<=|maximum/);
  });

  it("rejects an unknown property when additionalProperties is false", () => {
    const result = validateArguments({ location: "Paris", extra_field: "nope" }, weatherParams);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/additional/i);
  });

  it("collects multiple errors at once (allErrors: true)", () => {
    const result = validateArguments({ unit: "kelvin", days: 30 }, weatherParams);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

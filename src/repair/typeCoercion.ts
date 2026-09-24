/**
 * Repair strategy (d): type coercion for unambiguous, close-but-wrong-typed
 * arguments.
 *
 * Small local models very often produce a technically-valid JSON value with
 * the wrong JSON *type* for a declared parameter, most commonly a numeric
 * value quoted as a string (`"limit": "5"` when the schema says
 * `type: "number"`). This module walks the parsed arguments alongside the
 * tool's JSON Schema and coerces ONLY the following unambiguous cases:
 *
 *   - A string matching a strict, complete JSON number grammar
 *     (`^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$`) where the schema expects
 *     `"number"`.
 *   - The same, but additionally requiring no decimal point or exponent,
 *     where the schema expects `"integer"`.
 *   - The exact strings `"true"` / `"false"` (case-sensitive, no
 *     surrounding whitespace) where the schema expects `"boolean"`.
 *
 * What this deliberately does NOT coerce (left as-is, so schema validation
 * fails loudly instead of silently guessing):
 *   - Strings with leading/trailing whitespace (`" 5"`), leading zeros
 *     (`"007"`), or non-finite spellings (`"NaN"`, `"Infinity"`) — all
 *     ambiguous about the author's intent.
 *   - A decimal string (`"5.5"`) where the schema expects `"integer"`.
 *   - Any coercion between object/array and a scalar.
 *   - Booleans spelled `"True"`, `"1"`, `"yes"`, etc. — only the exact JSON
 *     literal spellings are treated as unambiguous.
 *   - A value that already satisfies one of the schema's declared types
 *     (nothing to coerce).
 *
 * Coercion recurses into `properties` (objects) and `items` (arrays) so
 * nested tool-call arguments are covered too.
 */

import type { CoercionRecord, JSONSchemaObject, JSONSchemaType } from "../types.js";

const COMPLETE_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const COMPLETE_INTEGER = /^-?(0|[1-9]\d*)$/;

export interface CoercionResult {
  value: unknown;
  coercions: CoercionRecord[];
}

export function coerceTypes(value: unknown, schema: JSONSchemaObject | undefined, path = "$"): CoercionResult {
  const coercions: CoercionRecord[] = [];
  const coerced = coerceNode(value, schema, path, coercions);
  return { value: coerced, coercions };
}

function coerceNode(
  value: unknown,
  schema: JSONSchemaObject | undefined,
  path: string,
  coercions: CoercionRecord[]
): unknown {
  if (!schema) return value;
  const types = normalizeTypes(schema.type);

  if (typeof value === "string" && types.length > 0 && !types.some((t) => matchesType(value, t))) {
    if (types.includes("number") && COMPLETE_NUMBER.test(value)) {
      coercions.push({ path, from: value, to: Number(value), rule: "numeric-string-to-number" });
      return Number(value);
    }
    if (types.includes("integer") && COMPLETE_INTEGER.test(value)) {
      coercions.push({ path, from: value, to: Number(value), rule: "numeric-string-to-integer" });
      return Number(value);
    }
    if (types.includes("boolean") && (value === "true" || value === "false")) {
      const boolValue = value === "true";
      coercions.push({ path, from: value, to: boolValue, rule: "boolean-string-to-boolean" });
      return boolValue;
    }
    // Not a safe, unambiguous coercion. Leave as-is; schema validation will
    // report it clearly instead of ToolGuard guessing.
    return value;
  }

  if (isPlainObject(value) && schema.properties) {
    const out: Record<string, unknown> = { ...value };
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (key in out) {
        out[key] = coerceNode(out[key], propSchema, `${path}.${key}`, coercions);
      }
    }
    return out;
  }

  if (Array.isArray(value) && schema.items) {
    return value.map((item, index) => coerceNode(item, schema.items, `${path}[${index}]`, coercions));
  }

  return value;
}

function normalizeTypes(type: JSONSchemaType | JSONSchemaType[] | undefined): JSONSchemaType[] {
  if (!type) return [];
  return Array.isArray(type) ? type : [type];
}

function matchesType(value: unknown, type: JSONSchemaType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

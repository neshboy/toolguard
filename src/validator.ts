/**
 * Real JSON Schema validation of tool-call arguments, backed by Ajv
 * (the same battle-tested validator used across the JS ecosystem) rather
 * than a hand-rolled reimplementation. ToolGuard's own value-add is the
 * repair/detection logic in `src/repair/*`; this module just wires that
 * output into a strict, spec-correct validator.
 */

// ajv's default export doesn't type-check as constructable under
// `moduleResolution: NodeNext` (a known CJS/ESM interop quirk -
// ajv-validator/ajv#2047); importing the named `Ajv` export instead sides
// steps it and works correctly both at compile time and at runtime.
import { Ajv } from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import type { JSONSchemaObject } from "./types.js";

const ajv = new Ajv({
  allErrors: true,
  strict: false, // tool schemas in the wild routinely use vendor keywords Ajv's strict mode rejects
  coerceTypes: false // ToolGuard does its own explicit, auditable coercion (see repair/typeCoercion.ts)
});

const compiledCache = new WeakMap<JSONSchemaObject, ValidateFunction>();

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateArguments(args: unknown, schema: JSONSchemaObject): SchemaValidationResult {
  const cached = compiledCache.get(schema);
  const validate: ValidateFunction = cached ?? ajv.compile(schema);
  if (!cached) {
    compiledCache.set(schema, validate);
  }

  const valid = validate(args);
  if (valid) {
    return { valid: true, errors: [] };
  }

  return { valid: false, errors: formatErrors(validate.errors) };
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  if (!errors) return ["schema validation failed"];
  return errors.map((err) => {
    const location = err.instancePath && err.instancePath.length > 0 ? err.instancePath : "(root)";
    return `${location} ${err.message ?? "is invalid"}`.trim();
  });
}

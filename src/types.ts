/**
 * ToolGuard type definitions.
 *
 * These shapes intentionally mirror the JSON Schema subset that real
 * tool-calling APIs use for declaring function/tool parameters
 * (OpenAI function calling, Anthropic tool_use, and MCP tool definitions
 * all converge on "type/properties/required/enum/items"-style JSON Schema
 * for the `parameters` / `input_schema` field).
 */

/**
 * A JSON Schema document, restricted (by convention, not by force) to the
 * subset actually used by tool-calling APIs: type, properties, required,
 * enum, items, additionalProperties, and a handful of string/number
 * constraints. Ajv (draft-07) is used underneath, so more of the spec than
 * this will validate correctly, but this is the subset ToolGuard's own
 * repair logic understands and coerces against.
 */
export interface JSONSchemaObject {
  type?: JSONSchemaType | JSONSchemaType[];
  properties?: Record<string, JSONSchemaObject>;
  required?: string[];
  enum?: unknown[];
  items?: JSONSchemaObject;
  additionalProperties?: boolean | JSONSchemaObject;
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  // Allow pass-through of any other real JSON Schema keyword (oneOf, anyOf,
  // $ref, etc.) without ToolGuard needing to model it explicitly. Ajv will
  // still validate these correctly even though our own coercion pass will
  // just skip over keywords it does not recognize.
  [key: string]: unknown;
}

export type JSONSchemaType =
  | "object"
  | "array"
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null";

/**
 * A single tool/function declaration, in the shape shared by OpenAI,
 * Anthropic, and MCP: a name and a JSON Schema describing its arguments.
 */
export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema describing the shape of the tool's arguments object. */
  parameters: JSONSchemaObject;
}

/** A structurally valid, schema-valid tool call ready to execute. */
export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export type RepairStrategy =
  | "unescaped-quote-repair"
  | "trailing-comma-repair"
  | "truncation-repair"
  | "type-coercion";

/** One concrete coercion ToolGuard applied while reconciling types. */
export interface CoercionRecord {
  path: string;
  from: unknown;
  to: unknown;
  rule: "numeric-string-to-number" | "numeric-string-to-integer" | "boolean-string-to-boolean";
}

export interface RepairSuccess {
  ok: true;
  toolCall: ToolCall;
  /** Which repair strategies actually changed something to get here. */
  repairsApplied: RepairStrategy[];
  /** Type coercions applied during schema reconciliation, if any. */
  coercions: CoercionRecord[];
  /** The exact raw text ToolGuard was given. */
  rawInput: string;
}

export type RejectionReason =
  | "empty_input"
  | "no_json_found"
  | "unrepairable_json"
  | "unrepairable_arguments_json"
  | "arguments_not_object"
  | "tool_name_mismatch"
  | "schema_validation_failed";

export interface RepairFailure {
  ok: false;
  reason: RejectionReason;
  /** Human-readable explanation of exactly why the call was rejected. */
  message: string;
  /** Repair strategies that were attempted before giving up, if any. */
  attemptedRepairs: RepairStrategy[];
  /** The exact raw text ToolGuard was given. */
  rawInput: string;
  /** The best-effort repaired text ToolGuard ended up with, for debugging. */
  bestEffortText?: string;
  /** Raw ajv validation errors, present only for schema_validation_failed. */
  validationErrors?: string[];
}

export type RepairResult = RepairSuccess | RepairFailure;

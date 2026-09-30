import { extractJsonCandidates } from "./extractJson.js";
import { runRepairPipeline } from "./repair/pipeline.js";
import { coerceTypes } from "./repair/typeCoercion.js";
import { validateArguments } from "./validator.js";
import type { RepairFailure, RepairResult, RepairStrategy, ToolDefinition } from "./types.js";

/**
 * The public shape ToolGuard understands for an "envelope": a tool call
 * that names the tool alongside its arguments. This covers OpenAI-style
 * (`arguments`, a JSON string), Anthropic tool_use-style (`input`, an
 * object), and MCP-style (`arguments`, an object) payloads.
 */
interface Envelope {
  name?: string;
  argumentsRaw?: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ParsedCandidate {
  parsed: unknown;
  applied: RepairStrategy[];
  attempted: RepairStrategy[];
  finalText: string;
}

type ParseOutcome = { ok: true; value: ParsedCandidate } | { ok: false; failure: RepairFailure };

/** Extracts, repairs, and JSON.parses a raw text blob. Shared by the
 * top-level call and by the nested (double-encoded) `arguments` string
 * case. */
function extractAndParse(rawOutput: string, rawInputForReport: string): ParseOutcome {
  const trimmed = rawOutput.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      failure: {
        ok: false,
        reason: "empty_input",
        message: "Raw model output was empty (or whitespace-only); there is nothing to repair.",
        attemptedRepairs: [],
        rawInput: rawInputForReport
      }
    };
  }

  const candidates = extractJsonCandidates(trimmed);
  if (candidates.length === 0) {
    return {
      ok: false,
      failure: {
        ok: false,
        reason: "no_json_found",
        message: "No `{` or `[` was found anywhere in the model output; there is no JSON to repair.",
        attemptedRepairs: [],
        rawInput: rawInputForReport
      }
    };
  }

  // Don't commit irrevocably to the first candidate: prose preceding the
  // real tool call can contain an unrelated bracket-like character (a
  // markdown list, a quoted example, ...) that looks like a JSON start but
  // never parses. Try each candidate's repair+parse pipeline in order and
  // use the first that actually yields valid JSON; if none do, report the
  // first candidate's failure since it's the most likely intended call.
  let firstFailure: RepairFailure | null = null;

  for (const candidate of candidates) {
    const { text, applied, attempted } = runRepairPipeline(candidate.candidate);

    try {
      const parsed = JSON.parse(text) as unknown;
      return { ok: true, value: { parsed, applied, attempted, finalText: text } };
    } catch (err) {
      if (!firstFailure) {
        const parseError = err instanceof Error ? err.message : String(err);
        firstFailure = {
          ok: false,
          reason: "unrepairable_json",
          message: `Automatic repair could not produce valid JSON. Underlying parse error: ${parseError}`,
          attemptedRepairs: attempted,
          rawInput: rawInputForReport,
          bestEffortText: text
        };
      }
    }
  }

  return { ok: false, failure: firstFailure! };
}

function readEnvelope(parsed: unknown): Envelope {
  if (!isPlainObject(parsed)) {
    return {};
  }
  const hasName = typeof parsed.name === "string";
  const hasArgs = "arguments" in parsed || "input" in parsed;
  if (hasName && hasArgs) {
    return {
      name: parsed.name as string,
      argumentsRaw: "arguments" in parsed ? parsed["arguments"] : parsed["input"]
    };
  }
  return {};
}

/**
 * Validates and repairs a raw tool-call completion from a (typically small,
 * local) language model against a single expected tool's JSON Schema.
 *
 * Returns either a genuinely schema-valid `ToolCall` ready to execute, or a
 * structured rejection explaining exactly why ToolGuard refused to forward
 * it. ToolGuard never guesses at missing content: anything it cannot
 * losslessly and unambiguously repair is rejected rather than forwarded.
 */
export function repairToolCall(rawOutput: string, tool: ToolDefinition): RepairResult {
  const parseOutcome = extractAndParse(rawOutput, rawOutput);
  if (!parseOutcome.ok) return parseOutcome.failure;

  const { parsed, applied, attempted, finalText } = parseOutcome.value;

  const envelope = readEnvelope(parsed);
  const isEnvelope = envelope.name !== undefined;

  if (isEnvelope && envelope.name !== tool.name) {
    return {
      ok: false,
      reason: "tool_name_mismatch",
      message: `Model called "${envelope.name}", but ToolGuard was asked to validate against "${tool.name}". This looks like a hallucinated or mismatched tool name, not a formatting problem, so ToolGuard will not attempt to repair it.`,
      attemptedRepairs: applied,
      rawInput: rawOutput,
      bestEffortText: finalText
    };
  }

  let argumentsValue: unknown;
  let allApplied: RepairStrategy[] = applied;
  let allAttempted: RepairStrategy[] = attempted;

  if (isEnvelope) {
    const rawArgs = envelope.argumentsRaw;
    if (rawArgs === undefined) {
      argumentsValue = {};
    } else if (typeof rawArgs === "string") {
      const innerOutcome = extractAndParse(rawArgs, rawOutput);
      if (!innerOutcome.ok) {
        return {
          ...innerOutcome.failure,
          reason: "unrepairable_arguments_json",
          message: `The tool call named "${envelope.name}" correctly, but its "arguments" field is a string that could not be repaired into valid JSON. ${innerOutcome.failure.message}`,
          attemptedRepairs: [...applied, ...innerOutcome.failure.attemptedRepairs]
        };
      }
      argumentsValue = innerOutcome.value.parsed;
      allApplied = [...applied, ...innerOutcome.value.applied];
      allAttempted = [...attempted, ...innerOutcome.value.attempted];
    } else {
      argumentsValue = rawArgs;
    }
  } else {
    // No envelope: the whole parsed payload is treated as the arguments
    // object directly (some small local models skip the {name, arguments}
    // wrapper entirely and just emit the arguments).
    argumentsValue = parsed;
  }

  if (!isPlainObject(argumentsValue)) {
    return {
      ok: false,
      reason: "arguments_not_object",
      message: `Resolved tool-call arguments must be a JSON object, but got ${describeType(argumentsValue)}.`,
      attemptedRepairs: dedupe(allApplied),
      rawInput: rawOutput,
      bestEffortText: JSON.stringify(argumentsValue)
    };
  }

  const { value: coercedArguments, coercions } = coerceTypes(argumentsValue, tool.parameters);
  if (coercions.length > 0) {
    allApplied = [...allApplied, "type-coercion"];
  }

  const validation = validateArguments(coercedArguments, tool.parameters);
  if (!validation.valid) {
    return {
      ok: false,
      reason: "schema_validation_failed",
      message: `Arguments for "${tool.name}" do not satisfy the declared schema: ${validation.errors.join("; ")}`,
      attemptedRepairs: dedupe(allApplied),
      rawInput: rawOutput,
      bestEffortText: JSON.stringify(coercedArguments),
      validationErrors: validation.errors
    };
  }

  return {
    ok: true,
    toolCall: { name: tool.name, arguments: coercedArguments as Record<string, unknown> },
    repairsApplied: dedupe(allApplied),
    coercions,
    rawInput: rawOutput
  };
}

/**
 * Convenience wrapper for the realistic multi-tool case: a model was given
 * several tool declarations and its raw output should be matched against
 * whichever one it named. If the named tool isn't in `tools` at all, that
 * is reported as a hallucinated-name rejection rather than attempted as a
 * repair.
 */
export function repairToolCallAmong(rawOutput: string, tools: ToolDefinition[]): RepairResult {
  const parseOutcome = extractAndParse(rawOutput, rawOutput);
  if (!parseOutcome.ok) return parseOutcome.failure;

  const envelope = readEnvelope(parseOutcome.value.parsed);
  if (envelope.name === undefined) {
    return {
      ok: false,
      reason: "tool_name_mismatch",
      message:
        "Multiple tools were declared, so ToolGuard needs the call to name one explicitly (an {name, arguments} envelope), but no tool name was found in the output.",
      attemptedRepairs: parseOutcome.value.applied,
      rawInput: rawOutput,
      bestEffortText: parseOutcome.value.finalText
    };
  }

  const match = tools.find((t) => t.name === envelope.name);
  if (!match) {
    return {
      ok: false,
      reason: "tool_name_mismatch",
      message: `Model called "${envelope.name}", which is not one of the declared tools (${tools.map((t) => t.name).join(", ")}). This looks like a hallucinated tool name.`,
      attemptedRepairs: parseOutcome.value.applied,
      rawInput: rawOutput,
      bestEffortText: parseOutcome.value.finalText
    };
  }

  return repairToolCall(rawOutput, match);
}

function describeType(value: unknown): string {
  if (Array.isArray(value)) return "an array";
  if (value === null) return "null";
  return `a ${typeof value}`;
}

function dedupe(strategies: RepairStrategy[]): RepairStrategy[] {
  return [...new Set(strategies)];
}

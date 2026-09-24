# ToolGuard

**ToolGuard hardens function/tool-calling for small local LLMs.** It sits between a
model's raw text output and your tool-execution layer, validates the tool call
against the tool's real JSON Schema, attempts genuine, narrowly-scoped
automatic repair of common malformation patterns, and only forwards a call
once it is actually schema-valid — otherwise it rejects the call with a
precise, structured reason instead of guessing.

## The problem

Frontier hosted models (GPT-4/5-class, Claude) are trained hard on structured
tool-calling and rarely emit broken JSON. Small local models in the
roughly-7B-to-30B range (and smaller — this project's own live test used a
3B model) are a different story: they routinely emit tool calls that are
*almost* right but not quite —

- a trailing comma left over from the training data's habits (`{"a": 1, "b": 2,}`),
- generation that gets cut off by a token limit or an early stop, leaving the
  JSON unclosed (`{"name": "get_weather", "arguments": {"location": "Par`),
- an inner quote inside a string argument that never got escaped
  (`{"query": "find "cats" videos"}`),
- an argument value of the right *content* but the wrong JSON *type*
  (`{"limit": "5"}` when the schema says `"type": "number"`),
- or a tool name that isn't real at all — hallucinated outright, or a
  close-but-wrong spelling of a tool that does exist.

Handing this straight to a tool executor is either a crash, a silently wrong
call, or (worse) a successful call with the wrong arguments. ToolGuard is the
narrow, honest layer in between: **is this call even well-formed and
schema-valid**, before anything gets to the point of deciding whether it's
*allowed*.

ToolGuard is intentionally **not** a policy/authorization gateway — that's a
different, separable concern (see this author's sibling project,
`mcpseatbelt`, which sits *downstream* of ToolGuard and decides whether an
already-well-formed MCP tool call is permitted to run). ToolGuard's only job
is upstream of that: turning "the model tried to call a tool" into either a
genuinely valid `{name, arguments}` pair, or a clear rejection.

## Install

```bash
npm install toolguard
```

Requires Node.js >= 18.17 (ESM only).

## Quick start

### Library

```ts
import { repairToolCall } from "toolguard";

const weatherTool = {
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
} as const;

// A real malformed completion a small local model might emit: trailing comma.
const rawModelOutput =
  '{"name": "get_weather", "arguments": {"location": "Paris", "unit": "celsius",}}';

const result = repairToolCall(rawModelOutput, weatherTool);

if (result.ok) {
  // result.toolCall = { name: "get_weather", arguments: { location: "Paris", unit: "celsius" } }
  // result.repairsApplied = ["trailing-comma-repair"]
  runTool(result.toolCall);
} else {
  // result.reason, result.message explain exactly why it was rejected
  console.error(`ToolGuard rejected the call: ${result.reason} — ${result.message}`);
}
```

`repairToolCall` understands three real-world tool-call envelope shapes so it
works against OpenAI-, Anthropic-, and MCP-style outputs without extra glue:

- `{"name": "...", "arguments": {...}}` (MCP, and the common convention)
- `{"name": "...", "arguments": "...json string..."}` (OpenAI's actual
  function-calling format: `arguments` is itself a JSON string, decoded and
  repaired recursively)
- `{"name": "...", "input": {...}}` (Anthropic `tool_use` naming)
- a bare arguments object with no envelope at all, for models that skip the
  wrapper entirely

If you have several declared tools and want ToolGuard to match the call
against whichever one the model actually named (and clearly flag it if the
name doesn't match *any* declared tool — a hallucinated name), use
`repairToolCallAmong(rawOutput, tools)`.

### CLI

Once published, the CLI runs as `toolguard` (via `npx toolguard` or after
`npm install -g toolguard`). From a clone of this repo (nothing published
yet), run it straight from source with `tsx`:

```bash
echo '{"name":"get_weather","arguments":{"location":"Paris","unit":"celsius",}}' \
  | npx tsx src/cli.ts --schema examples/get-weather.tool.json

# or, after `npm run build`:
echo '{"name":"get_weather","arguments":{"location":"Paris","unit":"celsius",}}' \
  | node dist/cli.js --schema examples/get-weather.tool.json
```

Prints the full result as JSON and exits `0` if the call was accepted, `1` if
rejected, `2` on a usage error. `--input <file>` reads from a file instead of
stdin.

## Repair strategies implemented (exactly four, plus JSON extraction)

Before any of the four repair strategies run, ToolGuard locates the JSON
object/array embedded in the raw completion by scanning for the first `{`/`[`
and walking forward with proper bracket/string tracking to find where it
ends (`src/extractJson.ts`) — this is what lets ToolGuard ignore
markdown code fences and leading/trailing prose ("Sure, here's the call:
\`\`\`json ... \`\`\` Let me know if that helps!") without any special-casing
for fences. This step also detects whether the JSON was truncated (never
balanced back to zero depth) so the truncation repair below knows to run.

All four strategies are implemented as real parsing/scanning passes over the
actual text (or parsed value), not regex hacks, and each is a provable no-op
on already-valid JSON, so it's safe to run all of them unconditionally:

**(a) Trailing comma repair** — `src/repair/trailingComma.ts`. Scans the text
tracking string state (respecting escapes) and drops a comma that is
followed (modulo whitespace) only by a closing `}`/`]`. Never touches a
`",}"`-shaped sequence that's actually inside a string value.
*Limit:* only removes commas that are genuinely trailing; it does not add a
missing comma between two members (see "what ToolGuard will not repair"
below).

**(b) Truncated/unclosed JSON repair** — `src/repair/truncation.ts`. Tracks
open `{`/`[` depth and string state through the whole input. At end-of-input:
closes an unterminated string (dropping any dangling, unpaired trailing
backslash first so it can't accidentally escape the quote being added);
removes a dangling `"key":` with no value, or a dangling trailing comma,
rather than inventing content; completes an unambiguous truncated bare
literal (`tru` → `true`, `fals` → `false`, `nul` → `null` — these are the
only three bare literals in JSON and each has a distinct first letter, so
completion is never ambiguous); drops an incomplete trailing number (`12.`,
`3e`) rather than guessing digits; and finally closes every remaining open
`{`/`[`, innermost first.
*Limit:* if there is nothing safe to close a value with, ToolGuard **cuts
back to the last complete member** instead of fabricating one. That means a
required field truncated mid-value can come back missing — schema validation
then correctly rejects the call for a missing required property, rather than
ToolGuard silently forwarding a call with an invented value.

**(c) Unescaped inner quote repair** — `src/repair/unescapedQuotes.ts`. This
malformation is genuinely ambiguous JSON, so ToolGuard applies the standard
practical heuristic: scanning inside a string, when a `"` is hit, peek ahead
(skipping whitespace) — if the next character is one of `, : } ]` or
end-of-input, it's a real closing quote; otherwise it's an unescaped inner
quote, so it gets escaped and scanning continues inside the same string.
*Limit (documented, not hidden):* this heuristic can misclassify a
legitimately-closed string that happens to be immediately followed by
another quote-delimited token in an unusual position. `tests/repair.unescapedQuotes.test.ts`
includes a real example of this exact misfire (a *missing comma* between two
members gets misread as an unescaped-quote situation) — the call still ends
up correctly rejected afterward (as `unrepairable_json`), because ToolGuard
never trusts a repair pass blindly; it always re-parses and re-validates.

**(d) Type coercion** — `src/repair/typeCoercion.ts`. Walks the parsed
arguments alongside the tool's JSON Schema and coerces *only*: a string that
is a complete, unambiguous JSON number literal where the schema expects
`number`/`integer` (rejecting integer coercion if the string has a decimal
point); and the exact strings `"true"`/`"false"` where the schema expects
`boolean`. Recurses into `properties` and `items`.
*Explicitly NOT attempted (left as-is, so validation fails loudly instead of
guessing):* strings with leading/trailing whitespace (`" 5"`), leading zeros
(`"007"` — could be an ID, not a number), non-finite spellings (`"NaN"`,
`"Infinity"`), decimal strings for `integer` fields (`"5.5"`), any
boolean spelling other than the exact literals (`"True"`, `"1"`, `"yes"`),
and any object/array-to-scalar coercion.

**What ToolGuard will not repair, on purpose:** a missing comma between two
members, a genuinely hallucinated tool name (rejected as `tool_name_mismatch`
rather than guessed at), or any malformation whose only fix would require
inventing content the model never actually produced. All of these are
rejected with a specific `reason` and a human-readable `message` rather than
silently forwarded or silently dropped.

## Did a real local model actually produce a real malformed call?

**Yes.** This environment had a real Ollama server running locally with
`llama3.2:3b` already pulled (`ollama list` → `llama3.2:3b`, 2.0GB,
`Q4_K_M`) — smaller than even the 7B floor this project is scoped around,
which only strengthens the point. `npm run demo:ollama`
(`scripts/live-ollama-demo.ts`) drives this real model over Ollama's HTTP API
with a real tool schema and feeds its real raw completions through
`repairToolCall`, with no mocking anywhere in that path.

Five real trials, reproduced multiple times while building this: three
natural-language prompts with a generous token budget came back well-formed
(this 3B model is decent at *short* JSON — small models don't fail *every*
time, they fail *often enough to be a real problem in production*). Cutting
`num_predict` down to deliberately reproduce the "generation got cut off"
failure mode reliably did reproduce it — genuine truncated JSON from the real
model, not a hand-written fixture:

```
$ npm run demo:ollama
...
## constrained token budget #1 (cuts off after required fields, mid-array) -> expect a REPAIRED, ACCEPTED call

### Raw model output (verbatim):
{"name": "log_incident", "arguments": {"summary": "CDN cache purge endpoint timed out three times in a row during the release.", "severity": 3, "tags": ["re

### ToolGuard result:
{
  "ok": true,
  "toolCall": {
    "name": "log_incident",
    "arguments": {
      "summary": "CDN cache purge endpoint timed out three times in a row during the release.",
      "severity": 3,
      "tags": [
        "re"
      ]
    }
  },
  "repairsApplied": [
    "truncation-repair"
  ],
  "coercions": [],
  "rawInput": "{\"name\": \"log_incident\", \"arguments\": {\"summary\": \"CDN cache purge endpoint timed out three times in a row during the release.\", \"severity\": 3, \"tags\": [\"re"
}

## constrained token budget #2 (cuts off before a required field) -> expect an honest REJECTION

### Raw model output (verbatim):
{"name": "log_incident", "arguments": {"summary": "Authentication service started returning 500 errors

### ToolGuard result:
{
  "ok": false,
  "reason": "schema_validation_failed",
  "message": "Arguments for \"log_incident\" do not satisfy the declared schema: (root) must have required property 'severity'",
  "attemptedRepairs": ["truncation-repair"],
  "rawInput": "{\"name\": \"log_incident\", \"arguments\": {\"summary\": \"Authentication service started returning 500 errors",
  "bestEffortText": "{\"summary\":\"Authentication service started returning 500 errors\"}",
  "validationErrors": ["(root) must have required property 'severity'"]
}
```

That second trial is the honest half of the story worth calling out
explicitly: the real model's generation was cut off *before* it produced the
required `severity` field at all. ToolGuard's truncation repair still closed
the JSON syntactically (`bestEffortText` shows a syntactically valid object),
but it correctly refused to invent a `severity` value, so schema validation
rejects the call with a precise, actionable reason instead of forwarding a
half-formed incident report. That is the intended behavior, not a bug: repair
fixes *syntax*, never *missing meaning*.

Run it yourself with `npm run demo:ollama` (requires a local Ollama server
with a model pulled; defaults to `llama3.2:3b`, override with `OLLAMA_MODEL`
and `OLLAMA_URL` env vars). The full, unedited transcript from this run is
reproduced above verbatim from real command output — nothing in that block
was hand-written.

For the automated test suite, ToolGuard uses hand-constructed malformed-JSON
fixtures (see `tests/`) so tests are deterministic and don't depend on a
local model being available in CI. Every fixture is based on the real,
documented failure patterns demonstrated above and elsewhere (trailing
commas, truncated generation, unescaped inner quotes, stringified numbers) —
none of them are idealized "clean" versions of the malformation, they're
constructed to look like what actually came out of the live model runs.

## API

```ts
function repairToolCall(rawOutput: string, tool: ToolDefinition): RepairResult;
function repairToolCallAmong(rawOutput: string, tools: ToolDefinition[]): RepairResult;

interface ToolDefinition {
  name: string;
  description?: string;
  parameters: JSONSchemaObject; // real JSON Schema: type/properties/required/enum/items/...
}

type RepairResult =
  | {
      ok: true;
      toolCall: { name: string; arguments: Record<string, unknown> };
      repairsApplied: RepairStrategy[]; // which of the 4 strategies actually changed something
      coercions: CoercionRecord[];
      rawInput: string;
    }
  | {
      ok: false;
      reason:
        | "empty_input"
        | "no_json_found"
        | "unrepairable_json"
        | "unrepairable_arguments_json"
        | "arguments_not_object"
        | "tool_name_mismatch"
        | "schema_validation_failed";
      message: string;
      attemptedRepairs: RepairStrategy[];
      rawInput: string;
      bestEffortText?: string;
      validationErrors?: string[];
    };
```

JSON Schema validation itself is delegated to [ajv](https://ajv.js.org/) — a
well-established, spec-correct validator — rather than reimplemented from
scratch. ToolGuard's own code is the extraction, repair, and coercion logic
in `src/repair/*` and `src/extractJson.ts`.

## Limitations

- **Repair, not clairvoyance.** ToolGuard never invents content the model
  didn't produce. A required field truncated away entirely stays missing and
  the call is rejected — that is by design, but it does mean ToolGuard can't
  "save" a call that lost essential information to truncation.
- **The unescaped-quote heuristic is a heuristic.** It resolves the common
  case correctly but can misclassify unusual input (documented above and
  pinned down by a test). ToolGuard always re-parses and re-validates after
  every repair pass rather than trusting a single pass, so a misfire here
  degrades to a clear rejection, not a silently wrong tool call.
- **No comma-insertion repair.** A missing comma between two JSON members is
  a different malformation than a trailing comma and is not attempted; it
  surfaces as `unrepairable_json`.
- **Single JSON Schema draft target.** ToolGuard's own type-coercion pass
  understands `type`/`properties`/`items` (the subset every major
  tool-calling API actually uses); ajv underneath supports much more of the
  spec for pure validation, but coercion won't reach into schema constructs
  ToolGuard's own walker doesn't recognize (e.g. `oneOf`/`anyOf` branches).
- **Tool-name matching is exact-string.** A hallucinated or misspelled tool
  name is rejected, not fuzzy-corrected — guessing which real tool a model
  "meant" is an authorization/routing decision ToolGuard deliberately leaves
  to the caller (or a project like `mcpseatbelt`), not a formatting repair.
- **Live-model testing is best-effort and non-deterministic.** The
  transcript above is real, but small local models are stochastic; re-running
  `npm run demo:ollama` may land on different exact wording (it has, across
  repeated runs while building this) even though the categories of outcome
  (clean pass / repaired-and-accepted / honestly-rejected) reproduced
  consistently in every run observed during development.

## Development

```bash
npm install
npm run build       # tsc -> dist/
npm run typecheck
npm test             # vitest run
npm run demo:ollama  # optional: requires a local Ollama server + model
```

## License

MIT © 2026 ToolGuard contributors. See [LICENSE](./LICENSE).

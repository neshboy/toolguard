/**
 * Live demo: point ToolGuard at a REAL small local model (via a locally
 * running Ollama server) and try to get it to emit a genuinely malformed
 * tool call, then show ToolGuard repairing it end-to-end.
 *
 * This is intentionally NOT part of the automated test suite: it depends
 * on an Ollama server actually running locally with a model pulled, which
 * is an environment precondition ToolGuard's CI/tests cannot assume. Run it
 * manually with `npm run demo:ollama`.
 */
import { repairToolCall } from "../src/repairToolCall.js";
import type { ToolDefinition } from "../src/types.js";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "llama3.2:3b";

const logIncidentTool: ToolDefinition = {
  name: "log_incident",
  description: "Log an operational incident report.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "One-sentence summary of the incident." },
      severity: { type: "integer", minimum: 1, maximum: 5 },
      tags: { type: "array", items: { type: "string" } }
    },
    required: ["summary", "severity"],
    additionalProperties: false
  }
};

interface Trial {
  label: string;
  prompt: string;
  numPredict: number;
}

const trials: Trial[] = [
  {
    label: "natural attempt #1 (generous token budget)",
    prompt: buildPrompt(
      'A customer reported that the checkout page says "Payment failed" even though their card was charged twice.'
    ),
    numPredict: 200
  },
  {
    label: "natural attempt #2 (quoted phrase inside the incident text)",
    prompt: buildPrompt(
      'The on-call engineer wrote in Slack: "prod db is on fire, rolling back now" and paged the team.'
    ),
    numPredict: 200
  },
  {
    label: "natural attempt #3 (list of tags, longer summary)",
    prompt: buildPrompt(
      "The nightly batch job failed at 2am due to a disk quota error on the reporting cluster, delaying the morning dashboards for finance and ops."
    ),
    numPredict: 200
  },
  {
    // A num_predict this tight reliably (observed in repeated runs while
    // building this demo) cuts llama3.2:3b off mid-array, after the
    // required `summary`/`severity` fields but partway through `tags`.
    // Real, reproducible truncated generation - not a hand-written fixture.
    label: "constrained token budget #1 (cuts off after required fields, mid-array) -> expect a REPAIRED, ACCEPTED call",
    prompt: buildPrompt(
      "The CDN cache purge endpoint timed out three times in a row during the release."
    ),
    numPredict: 42
  },
  {
    // An even tighter budget cuts the model off before it reaches the
    // required `severity` field at all. ToolGuard can still repair the
    // *syntax* (close the string/object), but correctly refuses to invent
    // a missing required value, so this one is rejected - on purpose.
    label: "constrained token budget #2 (cuts off before a required field) -> expect an honest REJECTION",
    prompt: buildPrompt(
      "The authentication service started returning 500 errors for roughly 12% of login attempts starting at 09:14 UTC, likely related to a bad config deploy."
    ),
    numPredict: 22
  }
];

function buildPrompt(incident: string): string {
  return [
    "You must respond with ONLY a single JSON object calling the log_incident tool. No prose, no markdown, no explanation.",
    "",
    "Tool schema:",
    JSON.stringify(logIncidentTool),
    "",
    'Respond in this exact shape: {"name": "log_incident", "arguments": {"summary": "...", "severity": <1-5>, "tags": ["...", "..."]}}',
    "",
    `Incident to log: ${incident}`,
    "",
    "JSON tool call:"
  ].join("\n");
}

async function generate(prompt: string, numPredict: number): Promise<string> {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.7, num_predict: numPredict }
    })
  });
  if (!res.ok) {
    throw new Error(`Ollama request failed: ${res.status} ${res.statusText} - ${await res.text()}`);
  }
  const body = (await res.json()) as { response: string };
  return body.response;
}

async function main(): Promise<void> {
  console.log(`# ToolGuard live local-model demo`);
  console.log(`# Model: ${MODEL} via ${OLLAMA_URL}`);
  console.log(`# Tool schema: ${JSON.stringify(logIncidentTool.parameters)}`);
  console.log("");

  let foundRealMalformation = false;

  for (const trial of trials) {
    console.log(`\n---\n## ${trial.label}\n`);
    let rawOutput: string;
    try {
      rawOutput = await generate(trial.prompt, trial.numPredict);
    } catch (err) {
      console.log(`(request failed: ${(err as Error).message})`);
      continue;
    }

    console.log("### Raw model output (verbatim):");
    console.log("```");
    console.log(rawOutput);
    console.log("```");

    const result = repairToolCall(rawOutput, logIncidentTool);
    console.log("\n### ToolGuard result:");
    console.log(JSON.stringify(result, null, 2));

    const wasAlreadyValid = result.ok && result.repairsApplied.length === 0;
    if (!wasAlreadyValid) {
      foundRealMalformation = true;
    }
  }

  console.log("\n---\n");
  if (foundRealMalformation) {
    console.log(
      "At least one real completion from the local model needed repair and/or rejection. " +
        "See the transcript above for the exact raw output and ToolGuard's exact response."
    );
  } else {
    console.log(
      "None of these trials produced a malformed call from the model this run " +
        "(small local models are non-deterministic; malformation rate varies by prompt, " +
        "temperature, and token budget). See README.md for hand-constructed fixtures " +
        "exercising every repair strategy regardless."
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

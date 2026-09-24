/**
 * Locates the JSON object/array embedded in a raw model completion.
 *
 * Small local models rarely emit *just* the JSON: they wrap it in prose
 * ("Sure, here's the call:"), markdown code fences (```json ... ```), or
 * leave trailing commentary after it. This scans for the first `{` or `[`
 * and then walks forward tracking bracket depth and string state to find
 * where that top-level value actually ends, ignoring anything before or
 * after it (fences included, since they simply fall outside the matched
 * range).
 *
 * If the top-level structure's depth never returns to zero (or a string is
 * left open) before the input runs out, `truncated` is reported so the
 * caller knows to run truncation repair.
 */
export interface JsonCandidate {
  candidate: string;
  truncated: boolean;
}

export function extractJsonCandidate(rawOutput: string): JsonCandidate | null {
  const start = findFirstBracket(rawOutput);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = rawOutput.length;
  let closed = false;

  for (let i = start; i < rawOutput.length; i++) {
    const ch = rawOutput[i]!;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        closed = true;
        break;
      }
    }
  }

  const candidate = rawOutput.slice(start, end);
  return { candidate, truncated: !closed };
}

function findFirstBracket(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{" || text[i] === "[") return i;
  }
  return -1;
}

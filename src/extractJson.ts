/**
 * Locates the JSON object/array embedded in a raw model completion.
 *
 * Small local models rarely emit *just* the JSON: they wrap it in prose
 * ("Sure, here's the call:"), markdown code fences (```json ... ```), or
 * leave trailing commentary after it. Naively committing to the very first
 * `{`/`[` in the text is not safe: prose preceding the real call can easily
 * contain an unrelated bracket-like character (a markdown list `[today,
 * tomorrow]`, a quoted example, etc.) that has nothing to do with the tool
 * call. Instead, this walks the text producing one candidate per top-level
 * bracket run: from each `{`/`[` not already consumed by an earlier
 * candidate, it tracks bracket depth and string state to find where that
 * value ends (or where the input runs out, if it never closes), then
 * resumes scanning for the next candidate immediately after that span.
 * Callers try each candidate in turn and use the first one that actually
 * parses as JSON, so an early false lead like `[today, tomorrow]` is simply
 * skipped over once it fails to parse.
 *
 * If a given candidate's depth never returns to zero (or a string is left
 * open) before the input runs out, that candidate's `truncated` is reported
 * so the caller knows to run truncation repair on it.
 */
export interface JsonCandidate {
  candidate: string;
  truncated: boolean;
}

/**
 * Returns only the first candidate, for backwards-compatible/simple callers.
 * Prefer `extractJsonCandidates` when the caller can verify a candidate
 * parses and should fall through to a later one otherwise.
 */
export function extractJsonCandidate(rawOutput: string): JsonCandidate | null {
  return extractJsonCandidates(rawOutput)[0] ?? null;
}

/**
 * Returns every top-level bracket-run candidate in `rawOutput`, in order.
 * Each candidate's span is skipped when looking for the next one, so
 * brackets nested inside an already-produced candidate are never re-offered
 * as separate candidates.
 */
export function extractJsonCandidates(rawOutput: string): JsonCandidate[] {
  const candidates: JsonCandidate[] = [];
  let searchFrom = 0;

  while (searchFrom < rawOutput.length) {
    const start = findNextBracket(rawOutput, searchFrom);
    if (start === -1) break;

    const { candidate, truncated, end } = extractFrom(rawOutput, start);
    candidates.push({ candidate, truncated });
    searchFrom = end;
  }

  return candidates;
}

function extractFrom(
  rawOutput: string,
  start: number
): { candidate: string; truncated: boolean; end: number } {
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

  return { candidate: rawOutput.slice(start, end), truncated: !closed, end };
}

function findNextBracket(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "{" || text[i] === "[") return i;
  }
  return -1;
}

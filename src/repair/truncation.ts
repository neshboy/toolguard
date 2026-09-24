/**
 * Repair strategy (b): truncated / unclosed JSON, from generation being cut
 * off (hit a token limit, stopped early, etc). This is the single most
 * common failure mode from small local models when `max_tokens` is tight or
 * the model just never emits a final `}`.
 *
 * Handles, in order:
 *   1. An unterminated string literal at end-of-input -> close it. Any
 *      dangling, unpaired trailing backslash (a cut-off escape sequence) is
 *      dropped first so it cannot accidentally escape the quote we add.
 *   2. A dangling `"key":` with no value at all -> the incomplete member is
 *      removed entirely (falls back to the last complete member/container),
 *      rather than inventing a value.
 *   3. A dangling trailing comma with nothing after it -> the comma is
 *      dropped.
 *   4. A truncated bare literal (`tru`, `fals`, `nul`) -> completed, since
 *      `true`/`false`/`null` are the only legal bare literals in JSON and
 *      each has a distinct first letter, so the completion is unambiguous.
 *   5. A truncated number (`12.`, `-`, `3e`) -> the incomplete member is
 *      removed entirely (never invents digits).
 *   6. Any still-open `{` / `[` are closed, innermost first.
 *   7. A final trailing-comma cleanup pass, since closing brackets can
 *      surface a comma that is now trailing.
 *
 * What it deliberately does NOT do: invent missing values, guess at
 * truncated string *content*, or repair anything nested more than one
 * "cut back to the previous comma or opening bracket" step away from the
 * truncation point. If ToolGuard cannot safely close the JSON without
 * guessing content, it truncates back to the last complete, well-formed
 * member instead of fabricating data.
 */

import type { RepairPassResult } from "./unescapedQuotes.js";
import { repairTrailingCommas } from "./trailingComma.js";

const LITERALS = ["true", "false", "null"] as const;

export function repairTruncation(input: string): RepairPassResult {
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
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
      stack.push(ch);
    } else if (ch === "}") {
      if (stack[stack.length - 1] === "{") stack.pop();
    } else if (ch === "]") {
      if (stack[stack.length - 1] === "[") stack.pop();
    }
  }

  let text = input;
  let changed = false;

  if (inString) {
    text = stripDanglingTrailingBackslash(text);
    text += '"';
    changed = true;
  }

  if (stack.length === 0 && !changed) {
    return { text, changed: false };
  }

  const trimmed = text.replace(/[ \t\r\n]+$/, "");
  const trailingWs = text.slice(trimmed.length);
  const lastChar = trimmed[trimmed.length - 1];

  if (lastChar === ":") {
    text = cutBackToLastBoundary(trimmed);
    changed = true;
  } else if (lastChar === ",") {
    text = trimmed.slice(0, -1);
    changed = true;
  } else {
    const bareMatch = /(?:^|[:,[])\s*([a-zA-Z]+)$/.exec(trimmed);
    if (bareMatch) {
      const word = bareMatch[1]!;
      if ((LITERALS as readonly string[]).includes(word)) {
        text = trimmed + trailingWs;
      } else {
        const completion = literalCompletion(word);
        if (completion !== null) {
          text = trimmed + completion;
          changed = true;
        } else {
          text = cutBackToLastBoundary(trimmed);
          changed = true;
        }
      }
    } else {
      const numMatch = /(?:^|[:,[])\s*(-?[\d.eE+-]+)$/.exec(trimmed);
      if (numMatch && !isCompleteJsonNumber(numMatch[1]!)) {
        text = cutBackToLastBoundary(trimmed);
        changed = true;
      } else {
        text = trimmed + trailingWs;
      }
    }
  }

  if (stack.length > 0) {
    for (let i = stack.length - 1; i >= 0; i--) {
      text += stack[i] === "{" ? "}" : "]";
    }
    changed = true;
  }

  const commaFixed = repairTrailingCommas(text);
  if (commaFixed.changed) {
    text = commaFixed.text;
    changed = true;
  }

  return { text, changed };
}

/** Returns the string needed to complete a strict, unambiguous prefix of
 * `true`/`false`/`null`, or `null` (the TS value) if `word` is not a valid
 * prefix of exactly one of them. */
function literalCompletion(word: string): string | null {
  for (const literal of LITERALS) {
    if (literal.startsWith(word) && word.length < literal.length) {
      return literal.slice(word.length);
    }
  }
  return null;
}

function isCompleteJsonNumber(candidate: string): boolean {
  return /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(candidate);
}

function stripDanglingTrailingBackslash(text: string): string {
  let count = 0;
  let i = text.length - 1;
  while (i >= 0 && text[i] === "\\") {
    count++;
    i--;
  }
  if (count % 2 === 1) {
    return text.slice(0, -1);
  }
  return text;
}

/**
 * Walk backward from the end of `text` and cut everything back to the
 * nearest same-depth `,` (dropping the comma too) or the nearest enclosing
 * `{`/`[` (kept, leaving the container empty at that point). Nested,
 * already-balanced `{}`/`[]` pairs and string literals encountered along
 * the way are skipped correctly rather than confusing the scan.
 */
function cutBackToLastBoundary(text: string): string {
  let i = text.length - 1;
  let depth = 0;

  while (i >= 0) {
    const ch = text[i];

    if (ch === '"') {
      i--;
      while (i >= 0) {
        if (text[i] === '"' && !isEscapedAt(text, i)) break;
        i--;
      }
      i--;
      continue;
    }

    if (ch === "}" || ch === "]") {
      depth++;
      i--;
      continue;
    }

    if (ch === "{" || ch === "[") {
      if (depth === 0) {
        return text.slice(0, i + 1);
      }
      depth--;
      i--;
      continue;
    }

    if (ch === "," && depth === 0) {
      return text.slice(0, i);
    }

    i--;
  }

  return text;
}

function isEscapedAt(text: string, index: number): boolean {
  let count = 0;
  let i = index - 1;
  while (i >= 0 && text[i] === "\\") {
    count++;
    i--;
  }
  return count % 2 === 1;
}

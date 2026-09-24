/**
 * Repair strategy (a): trailing commas before a closing `}` or `]`.
 *
 *   {"a": 1, "b": 2,}          ->  {"a": 1, "b": 2}
 *   {"items": [1, 2, 3,]}      ->  {"items": [1, 2, 3]}
 *
 * Implemented as a character scan (not a blind regex) that tracks whether
 * we are inside a string literal, so a literal `",}"` sequence that happens
 * to appear inside a string value is never touched. This is a no-op on
 * already-valid JSON, since valid JSON never has a comma directly followed
 * (modulo whitespace) by a closing bracket.
 */

import type { RepairPassResult } from "./unescapedQuotes.js";

export function repairTrailingCommas(input: string): RepairPassResult {
  let out = "";
  let inString = false;
  let escaped = false;
  let changed = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (inString) {
      out += ch;
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
      out += ch;
      continue;
    }

    if (ch === ",") {
      const next = peekNextNonWhitespace(input, i + 1);
      if (next === "}" || next === "]") {
        // Drop the trailing comma entirely.
        changed = true;
        continue;
      }
    }

    out += ch;
  }

  return { text: out, changed };
}

function peekNextNonWhitespace(text: string, from: number): string | null {
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") continue;
    return ch;
  }
  return null;
}

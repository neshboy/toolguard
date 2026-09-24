/**
 * Repair strategy (c): unescaped inner quotes inside a JSON string value.
 *
 * Small local models frequently emit something like:
 *
 *   {"query": "find "cats" videos"}
 *
 * where the model meant `cats` to be part of the string but forgot to
 * escape the inner quotes. This is not something a strict JSON parser can
 * ever resolve with certainty (the grammar is genuinely ambiguous), so this
 * module applies the same practical heuristic used by most JSON-repair
 * tooling: when scanning inside a string and a `"` is encountered, look
 * ahead (skipping whitespace) at the next character.
 *
 *   - If it is one of `,` `:` `}` `]`, or end-of-input, treat the quote as a
 *     legitimate closing quote.
 *   - Otherwise, treat it as an inner, unescaped quote: escape it and keep
 *     scanning the same string.
 *
 * This is provably a no-op on already well-formed JSON: in valid JSON, a
 * real closing quote is always immediately followed by one of those
 * structural characters (or the end of input), so the heuristic never
 * mis-fires on correct input.
 *
 * Known limitation (documented, not silently papered over): if a
 * legitimately-closed string happens to be immediately followed by another
 * quote-delimited token in an unexpected position, or if the malformed
 * inner quote itself happens to be immediately followed by a structural
 * character (e.g. `"He said "wow": true"` where the inner quote precedes a
 * colon), the heuristic can misclassify the boundary. This trade-off is
 * inherent to repairing this specific malformation and is why ToolGuard
 * still runs full JSON Schema validation afterwards rather than trusting
 * any repair blindly.
 */

const STRUCTURAL_AFTER_CLOSE = new Set([",", ":", "}", "]"]);

export interface RepairPassResult {
  text: string;
  changed: boolean;
}

export function repairUnescapedQuotes(input: string): RepairPassResult {
  let out = "";
  let inString = false;
  let escaped = false;
  let changed = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    if (!inString) {
      if (ch === '"') {
        inString = true;
      }
      out += ch;
      continue;
    }

    // We are inside a string.
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      const next = peekNextNonWhitespace(input, i + 1);
      if (next === null || STRUCTURAL_AFTER_CLOSE.has(next)) {
        // Genuine closing quote.
        out += ch;
        inString = false;
      } else {
        // Inner, unescaped quote: escape it and stay inside the string.
        out += '\\"';
        changed = true;
      }
      continue;
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

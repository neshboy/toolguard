import type { RepairStrategy } from "../types.js";
import { repairUnescapedQuotes } from "./unescapedQuotes.js";
import { repairTrailingCommas } from "./trailingComma.js";
import { repairTruncation } from "./truncation.js";

export interface PipelineResult {
  text: string;
  /** Strategies that actually changed the text. */
  applied: RepairStrategy[];
  /** Strategies that were run, whether or not they changed anything. */
  attempted: RepairStrategy[];
}

/**
 * Runs all three text-level repair passes, in the order that keeps each one
 * safe: fix string boundaries first (so later passes can trust `"`
 * tracking), then drop trailing commas, then balance brackets/close
 * truncated structures. Every pass is a documented no-op on already-valid
 * JSON, so running all three unconditionally is safe even when nothing is
 * actually broken.
 */
export function runRepairPipeline(candidate: string): PipelineResult {
  const attempted: RepairStrategy[] = ["unescaped-quote-repair", "trailing-comma-repair", "truncation-repair"];
  const applied: RepairStrategy[] = [];

  let text = candidate;

  const quoteResult = repairUnescapedQuotes(text);
  text = quoteResult.text;
  if (quoteResult.changed) applied.push("unescaped-quote-repair");

  const commaResult = repairTrailingCommas(text);
  text = commaResult.text;
  if (commaResult.changed) applied.push("trailing-comma-repair");

  const truncationResult = repairTruncation(text);
  text = truncationResult.text;
  if (truncationResult.changed) applied.push("truncation-repair");

  return { text, applied, attempted };
}

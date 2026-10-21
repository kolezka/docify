import { Tiktoken } from "js-tiktoken/lite";
import o200k from "js-tiktoken/ranks/o200k_base";

// One tokenizer for every budget so numbers are comparable across modes and adapters.
export const TOKENIZER = "o200k_base";
const encoder = new Tiktoken(o200k);

// BPE time grows quadratically on long runs without whitespace (10k chars took 3.4 s).
// Such runs are counted in pieces; merges across a cut only lower the true count, so the
// sum never undercounts the budget.
const LONG_RUN = /\S{64,}/g;

export function countTokens(text: string): number {
  let total = 0;
  let last = 0;
  for (const m of text.matchAll(LONG_RUN)) {
    total += encoder.encode(text.slice(last, m.index)).length;
    for (let i = 0; i < m[0].length; i += 64) total += encoder.encode(m[0].slice(i, i + 64)).length;
    last = m.index + m[0].length;
  }
  return total + encoder.encode(text.slice(last)).length;
}

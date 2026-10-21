import { Tiktoken } from "js-tiktoken/lite";
import o200k from "js-tiktoken/ranks/o200k_base";

// One tokenizer for every budget so numbers are comparable across modes and adapters.
export const TOKENIZER = "o200k_base";
const encoder = new Tiktoken(o200k);

export function countTokens(text: string): number {
  return encoder.encode(text).length;
}

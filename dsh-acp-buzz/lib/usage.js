// Per-prompt token usage for the ACP `session/prompt` answer.
//
// Why: dsh's ACP server sends only context occupancy (`usage_update`), not
// what a turn spent. dsh does record each model call's usage in its durable
// `assistant/message` event, so the bundle sums the calls of one prompt and
// adds ACP's optional `usage` field to the prompt answer, which a client
// such as the Buzz plugin can record.
//
// dsh counts are disjoint: `inputTokens` is uncached input only, and cached
// input is in `cacheReadTokens` / `cacheWriteTokens` (dsh-llm TokenUsage).
// The ACP fields keep that split, and `totalTokens` is the sum of all four
// counts, so no token is counted twice.

/** A fresh sum for one prompt. `calls` tells "no model call" from zero. */
export function emptyUsage() {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
}

/** Adds one model call's dsh usage. A missing or bad count adds nothing:
 * the numbers come from a provider, so each one is checked. */
export function addUsage(sum, usage) {
  if (usage === null || typeof usage !== "object") return;
  sum.calls += 1;
  for (const key of Object.keys(sum)) {
    if (key === "calls") continue;
    const value = usage[key];
    if (Number.isSafeInteger(value) && value >= 0) sum[key] += value;
  }
}

/** The ACP `Usage` object for one prompt. */
export function toAcpUsage(sum) {
  return {
    inputTokens: sum.inputTokens,
    outputTokens: sum.outputTokens,
    totalTokens:
      sum.inputTokens +
      sum.outputTokens +
      sum.cacheReadTokens +
      sum.cacheWriteTokens,
    cachedReadTokens: sum.cacheReadTokens,
    cachedWriteTokens: sum.cacheWriteTokens,
    thoughtTokens: sum.reasoningTokens,
  };
}

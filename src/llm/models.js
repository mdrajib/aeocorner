/**
 * The Claude models answer extraction can run on (MVP §7.7, decision D4), with what each costs and how each is
 * asked. Prices are US dollars per million tokens, checked 2026-10-03 against Anthropic's published pricing.
 * One dollar per million tokens is exactly one micro-dollar per token, so cost in micro-dollars is tokens × price.
 *
 * The Batch API halves every token price (input, output, cache writes and reads). Cache writes here are the
 * 5-minute kind; reads are what a cached prefix costs on each later request.
 *
 *   opus55   claude-opus-5-5 at low effort. Thinking is always on for this model and can't be switched off (a
 *            request that tries gets a 400); effort is the only control, and its default is medium, so it is set.
 *   haiku45  claude-haiku-4-5. No effort setting (the API rejects one) and no thinking. Its cached prefix must be
 *            at least 4,096 tokens, or nothing is cached at all.
 *
 * The spec named `claude-opus-5`; Opus 5.5 replaced it as the current Opus on the same feature set at a lower price
 * ($4/$20 against $5/$25), so it is the default candidate (ADR-0007).
 */
export const MODELS = Object.freeze({
  opus55: Object.freeze({
    key: 'opus55',
    id: 'claude-opus-5-5',
    tag: 'opus55',
    effort: 'low',
    maxTokens: 8_000,
    minCacheTokens: 512,
    price: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  }),
  haiku45: Object.freeze({
    key: 'haiku45',
    id: 'claude-haiku-4-5',
    tag: 'haiku45',
    effort: null,
    maxTokens: 4_000,
    minCacheTokens: 4_096,
    price: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  }),
});

export const DEFAULT_MODEL = 'opus55';

export function modelProfile(key) {
  const profile = MODELS[key];
  if (!profile)
    throw new RangeError(
      `Unknown extraction model "${key}": use ${Object.keys(MODELS).join(' or ')}`,
    );
  return profile;
}

/** The profile whose API model id this is (results name the model that answered), or null. */
export const profileForModelId = (id) => Object.values(MODELS).find((m) => m.id === id) ?? null;

/**
 * What one reply cost, in micro-dollars, from its `usage` block. `usage.input_tokens` counts only the uncached part
 * of the prompt; cache writes and reads are reported separately and priced separately.
 */
export function costMicros(profile, usage, { batch = false } = {}) {
  const p = profile.price;
  const total =
    (usage?.input_tokens ?? 0) * p.input +
    (usage?.cache_creation_input_tokens ?? 0) * p.cacheWrite +
    (usage?.cache_read_input_tokens ?? 0) * p.cacheRead +
    (usage?.output_tokens ?? 0) * p.output;
  return Math.round(batch ? total / 2 : total);
}

/** Usage blocks added up, for one ledger row per batch. */
export function sumUsage(usages) {
  const sum = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };
  for (const u of usages) {
    for (const key of Object.keys(sum)) sum[key] += u?.[key] ?? 0;
  }
  return sum;
}

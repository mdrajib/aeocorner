/**
 * Which provider answers a question for an engine: its primary, or its fallback when the primary's circuit
 * breaker is open (MVP §7.8, `engines.primary_provider_code` / `fallback_provider_code`).
 *
 * `admit(providerCode, engineCode)` is the breaker check. It says:
 *   'allow'  the breaker is closed
 *   'probe'  half open, and this request has been picked as the test request
 *   'deny'   open (or half open with the probe slot taken)
 *
 * Returns the route to use, or null when both are denied, in which case the answer for this engine is
 * "couldn't check", never a guess and never "not mentioned".
 */
export async function chooseRoute(engine, admit) {
  const candidates = [
    { kind: 'primary', provider: engine.primaryProviderCode, method: engine.primaryMethod },
    { kind: 'fallback', provider: engine.fallbackProviderCode, method: engine.fallbackMethod },
  ];
  for (const { kind, provider, method } of candidates) {
    if (!provider) continue;
    const verdict = await admit(provider, engine.code);
    if (verdict !== 'deny') return { provider, method, kind, probe: verdict === 'probe' };
  }
  return null;
}

/**
 * Reading a Claude reply that must be JSON of one shape: the check every structured call shares (the Brand Kit and
 * the question generator; answer extraction has its own, older copy in extraction.js with the same reasons).
 *
 * `{ ok: true, json }`, or `{ ok: false, reason, detail }` where reason is one of
 *   refusal       the model declined (stop_reason "refusal")
 *   max_tokens    the reply was cut off: it can't be trusted, even if what arrived parses
 *   no_text       no text block at all
 *   invalid_json  the text isn't JSON
 * Whether the JSON has the right shape is the caller's schema to decide.
 */
export function readJsonReply(message) {
  if (message?.stop_reason === 'refusal') {
    return { ok: false, reason: 'refusal', detail: message.stop_details?.category ?? null };
  }
  if (message?.stop_reason === 'max_tokens') return { ok: false, reason: 'max_tokens' };
  const text = (message?.content ?? [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!text.trim()) return { ok: false, reason: 'no_text' };
  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}

/** Text from a stranger's website, made safe to put in our own tags and attributes: it can't close or open one. */
export const fenced = (text, max) =>
  String(text ?? '')
    .replace(/[<>"]/g, (c) => ({ '<': '‹', '>': '›', '"': '”' })[c])
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

/**
 * The facts registry (MVP F8 step 5): the only things a draft may state as fact. Two kinds, numbered so a brief can
 * point at them and a draft can be checked against them:
 *
 *   b1, b2, …  from the customer's own Brand Kit (identity, offerings, facts): what the customer said is true
 *   r1, r2, …  from research: a claim with the address it came from and a quotation that was found on that page
 *
 * Pure. The ids are stable for one registry (Brand Kit facts first, in kit order, then research in the order found),
 * and a registry is rebuilt from the stored Brand Kit and research each time, so editing the kit changes what the next
 * draft may say, never what an old draft claims.
 */

const clip = (text, max) => {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
};

/** Brand Kit facts as sentences. */
export function brandFacts(kit) {
  const out = [];
  const id = kit?.identity ?? {};
  if (id.definition)
    out.push(`${id.brandName} is ${clip(id.definition, 300).replace(/^is\s+/i, '')}`);
  if (id.category && id.geography)
    out.push(`${id.brandName} is a ${id.category} serving ${id.geography}.`);
  else if (id.category) out.push(`${id.brandName} is a ${id.category}.`);
  else if (id.geography) out.push(`${id.brandName} serves ${id.geography}.`);
  if (id.legalName) out.push(`The legal name of ${id.brandName} is ${id.legalName}.`);
  for (const o of kit?.offerings?.items ?? []) {
    const parts = [o.name, o.description, o.price ? `Price: ${o.price}` : ''].filter(Boolean);
    out.push(clip(parts.join('. '), 400));
  }
  for (const d of kit?.offerings?.differentiators ?? []) out.push(clip(d, 300));
  for (const f of kit?.facts ?? []) out.push(clip(`${f.label}: ${f.value}`, 400));
  return out.filter(Boolean);
}

/**
 * @param {object} input
 * @param {object} input.kit       the Brand Kit data
 * @param {{claim, url, quote?, verified?}[]} [input.research]  research facts that passed the evidence check
 * @returns {{id: string, source: 'brand_kit'|'research', text: string, url?: string, quote?: string, verified: boolean}[]}
 */
export function buildRegistry({ kit, research = [] }) {
  const registry = brandFacts(kit).map((text, i) => ({
    id: `b${i + 1}`,
    source: 'brand_kit',
    text,
    verified: true,
  }));
  research.forEach((fact, i) => {
    registry.push({
      id: `r${i + 1}`,
      source: 'research',
      text: clip(fact.claim, 300),
      url: fact.url,
      quote: fact.quote ? clip(fact.quote, 300) : undefined,
      verified: fact.verified === true,
    });
  });
  return registry;
}

/** What a draft may rely on: Brand Kit facts and research that was verified against the page it came from. */
export const usableFacts = (registry) => registry.filter((f) => f.verified);

/** The sentences QC compares claims with. */
export const factTexts = (registry) =>
  usableFacts(registry).flatMap((f) => (f.quote ? [f.text, f.quote] : [f.text]));

/** The sources a link in a draft may point to for a claim. */
export const sourceList = (registry) =>
  usableFacts(registry)
    .filter((f) => f.url)
    .map((f) => ({ url: f.url, quote: f.quote }));

/**
 * The free llms.txt generator (Milestone 17, task 17.11). Pure: from a name, a summary and a list of links to the text of an
 * llms.txt file and the findings that explain it. It writes only what was typed.
 *
 * The format is the common one (llmstxt.org): a `#` title, a `>` summary, then a `##` section of `- [title](address): note`
 * lines. Nothing here is an official standard that any engine is known to read, and the findings say so plainly (founder
 * decision G5): adding the file is harmless, and nobody has shown it changes what an engine says.
 *
 * Markdown cannot be broken from a field: brackets, line breaks and a leading `#` or `>` are refused in a title or a name,
 * and an address has its parentheses written as escapes, so one link is always one line.
 */

export const MAX_LINKS = 10;
export const MAX_NAME = 100;
export const MAX_SUMMARY = 300;
const MAX_TITLE = 100;
const MAX_NOTE = 200;

/** A full web address with its path and query kept: a missing https:// is added. `null` when it is not one. */
export function linkAddress(raw) {
  if (raw.length > 2048) return null;
  const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(text);
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password)
      return null;
    if (!u.hostname.includes('.')) return null;
    u.hash = '';
    return u.href.replace(/\(/g, '%28').replace(/\)/g, '%29');
  } catch {
    return null;
  }
}

/** A single line of text with nothing that Markdown would read as structure. */
export function plainLine(raw, label, max) {
  const value = String(raw ?? '').trim();
  if (value.length > max) return { error: `Keep ${label} under ${max} characters.` };
  if (/[[\]\r\n]/.test(value)) return { error: `Use plain text in ${label}, with no brackets.` };
  return { value };
}

/**
 * One link per line: `Title | address | optional note`. `{ links }`, or `{ error }` naming the first line that cannot be used.
 */
export function parseLinks(text) {
  const links = [];
  const lines = String(text ?? '').split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const at = `Line ${i + 1}`;
    const parts = line.split('|').map((p) => p.trim());
    if (parts.length < 2 || parts.length > 3 || !parts[0] || !parts[1])
      return {
        error: `${at}: write a title, then |, then the address, such as Pricing | yourcompany.com/pricing | Plans and prices.`,
      };
    const title = plainLine(parts[0], 'the title', MAX_TITLE);
    if (title.error) return { error: `${at}: ${title.error}` };
    const address = linkAddress(parts[1]);
    if (!address)
      return { error: `${at}: enter a full web address, such as https://yourcompany.com/pricing.` };
    const note = plainLine(parts[2] ?? '', 'the note', MAX_NOTE);
    if (note.error) return { error: `${at}: ${note.error}` };
    if (links.some((l) => l.address === address)) continue;
    links.push({ title: title.value, address, note: note.value });
    if (links.length > MAX_LINKS)
      return {
        error: `Use at most ${MAX_LINKS} links. An llms.txt is a short list of your best pages.`,
      };
  }
  return { links };
}

/** @returns {{ text: string }} the file, ending with one newline */
export function generateLlms({ name, summary = '', links = [] }) {
  const lines = [`# ${name}`];
  if (summary) lines.push('', `> ${summary}`);
  if (links.length) {
    lines.push('', '## Key pages');
    for (const l of links) lines.push(`- [${l.title}](${l.address})${l.note ? `: ${l.note}` : ''}`);
  }
  return { text: `${lines.join('\n')}\n` };
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The findings page for a generated file (not yet through `normalizeFindings`). */
export function llmsGeneratorFindings({ name, summary = '', links = [], text }) {
  const rows = [
    { label: 'Name', state: 'good', value: 'Added', detail: name },
    {
      label: 'Summary',
      state: summary ? 'good' : 'neutral',
      value: summary ? 'Added' : 'None',
      detail: summary || 'You did not enter a summary. A line saying what you do helps a reader.',
    },
    {
      label: 'Links',
      state: links.length ? 'good' : 'neutral',
      value: String(links.length),
      detail: links.length
        ? links.map((l) => l.title).join(', ')
        : 'You did not add any links, so the file lists none.',
    },
  ];
  return {
    headline: `Your llms.txt is ready, with ${plural(links.length, 'link')}`,
    sections: [{ heading: 'What your file contains', rows }],
    output: { filename: 'llms.txt', text },
    notes: [
      'Save the text as llms.txt at the top level of your site, so it opens at yourcompany.com/llms.txt.',
      'No AI engine is known to need an llms.txt file. Adding one is harmless, and it takes a few minutes.',
      'Nobody has shown that it changes what an engine says about you, and this tool does not promise it will.',
      'Only list pages that exist and that you want people to find. Our audit reads pages, robots.txt and sitemaps, which matter more.',
    ],
  };
}

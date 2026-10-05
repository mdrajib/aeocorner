import { load } from 'cheerio';
import { sanitizeBody, wordsOf } from './content-html.js';
import { QC_CHECKS } from './content-qc.js';
import {
  BOARD_COLUMNS,
  STATUS_LABELS,
  STATUS_TONES,
  approvalBlockers,
} from './content-lifecycle.js';
import { FORMAT_LABELS } from './evidence-pack.js';
import { scriptTag } from './jsonld.js';

/**
 * What the Content Studio screens say (UI_DESIGN D5, D6), decided in code so a template only lays it out: the board's
 * columns, the check's panel, the research and evidence the customer is shown, what may be pressed now, and the two ways
 * out for a site that is not on WordPress (HTML with its structured data, and Markdown). Pure.
 */

export const KIND_LABELS = Object.freeze({ new: 'New page', refresh: 'Refresh' });

/** One card of the board. */
export function itemCard(item, { projectBase }) {
  return {
    href: `${projectBase}/content/${item.publicId}`,
    title: item.title,
    status: item.status,
    badge: {
      text: STATUS_LABELS[item.status] ?? item.status,
      tone: STATUS_TONES[item.status] ?? 'neutral',
    },
    format: FORMAT_LABELS[item.format] ?? FORMAT_LABELS.other,
    kind: KIND_LABELS[item.kind] ?? item.kind,
    score: item.qcScore ?? null,
    blocked: (item.qc?.blocking ?? []).length > 0,
  };
}

/** The board: the three columns with their cards, and what an empty column says. */
export function boardColumns(items, { projectBase }) {
  const EMPTY = {
    working: 'Nothing is being written right now.',
    review: 'Drafts wait here for you to read, edit and approve.',
    published: 'Pages you publish appear here.',
  };
  return BOARD_COLUMNS.map((column) => ({
    key: column.key,
    label: column.label,
    empty: EMPTY[column.key],
    cards: items
      .filter((i) => column.statuses.includes(i.status))
      .map((i) => itemCard(i, { projectBase })),
  }));
}

const CHECK_HELP = Object.freeze({
  answer_first: 'Each question heading is followed at once by an answer of 60 words or fewer.',
  unsupported_claims:
    'Every figure has a source, nothing is marked [needs source], no quotation is invented.',
  heading_structure:
    'Three or more sections, mostly questions, no skipped levels, a sensible length.',
  reading_level: 'Plain enough for your Brand Kit’s reading level.',
  banned_words: 'None of the words your Brand Kit says to avoid, and no stock filler.',
  overlap: 'Not a copy of a page your site already has.',
  schema_valid: 'The structured data is valid and says only what the page says.',
});

const STATUS_TEXT = { pass: 'Good', warn: 'Could be better', fail: 'Needs work' };
const STATUS_TONE = { pass: 'success', warn: 'warning', fail: 'danger' };

/** The check's panel: the score, and each check with its points and what is wrong. */
export function qcView(qc, { revisionIsCurrent = true } = {}) {
  if (!qc) return null;
  const labels = Object.fromEntries(QC_CHECKS.map((c) => [c.code, c.label]));
  return {
    score: qc.score,
    ready: qc.ready === true && revisionIsCurrent,
    stale: !revisionIsCurrent,
    tone: qc.blocking?.length
      ? 'danger'
      : qc.score >= 80
        ? 'success'
        : qc.score >= 60
          ? 'warning'
          : 'danger',
    headline: qc.blocking?.length
      ? 'This draft has a problem that has to be fixed before you can approve it.'
      : qc.score >= 80
        ? 'This draft passes our checks.'
        : 'This draft can be better. You can still approve it if you are happy with it.',
    checks: (qc.checks ?? []).map((c) => ({
      code: c.code,
      label: labels[c.code] ?? c.label,
      help: CHECK_HELP[c.code] ?? '',
      points: c.points,
      weight: c.weight,
      status: c.status,
      statusText: STATUS_TEXT[c.status] ?? c.status,
      tone: STATUS_TONE[c.status] ?? 'neutral',
      blocking: Boolean(c.blocking),
      findings: (c.findings ?? []).slice(0, 8),
    })),
    note: qc.schemaNote ?? null,
    // Only on a page written to win citations: advisory, never part of the score.
    citable: Array.isArray(qc.citable)
      ? qc.citable.map((c) => ({
          code: c.code,
          label: c.label,
          tone: c.status === 'pass' ? 'success' : 'warning',
          statusText: c.status === 'pass' ? 'Yes' : 'Could be better',
          finding: c.finding ?? null,
        }))
      : null,
  };
}

/** What research found, for the customer to see and judge. */
export function researchView(research) {
  if (!research) return null;
  const pack = research.pack ?? {};
  return {
    warning: research.warning ?? null,
    facts: (research.facts ?? []).map((f) => ({
      claim: f.claim,
      url: f.url,
      quote: f.quote ?? null,
      verified: f.verified === true,
      label:
        f.verified === true ? 'Checked against the page' : 'Not checked: not used in the draft',
    })),
    searches: research.searches ?? 0,
    question: pack.question ?? null,
    engines: (pack.engines ?? []).map((e) => ({
      code: e.engineCode,
      readable: e.readable,
      named: (e.named ?? []).map((n) => `${n.name} (${n.count})`).join(', ') || 'nobody',
    })),
    sources: (pack.sources ?? []).slice(0, 8).map((s) => ({
      url: s.url,
      title: s.title ?? s.domain ?? s.url,
      cited: s.timesCited,
      own: s.isOwn === true,
      format: s.format ? FORMAT_LABELS[s.format] : null,
    })),
    formatBasis: pack.format?.basis ?? null,
  };
}

/**
 * What may be pressed on an item right now, and why not when it may not.
 *
 * @param {object} input
 * @param {object} input.item
 * @param {{status: string, config: object}|null} input.integration  the WordPress connection
 * @param {boolean} input.canApprove  the person may approve and publish (`site.approve`)
 * @param {boolean} input.canEdit     the person may edit (`content.create`)
 */
export function publishPanel({ item, integration, canApprove, canEdit }) {
  const connected = integration?.status === 'connected';
  const blockers = ['ready'].includes(item.status)
    ? approvalBlockers({
        qc: item.qc,
        qcRevisionId: item.qc?.revisionId ? BigInt(item.qc.revisionId) : null,
        currentRevisionId: item.currentRevisionId,
        hasJsonld: Boolean(item.jsonld),
      })
    : [];
  return {
    canEdit: canEdit && ['ready', 'approved'].includes(item.status),
    canApprove: canApprove && item.status === 'ready' && blockers.length === 0,
    approveBlockers: item.status === 'ready' ? blockers : [],
    mayApprove: canApprove,
    canUnapprove: canEdit && item.status === 'approved',
    canPublish: canApprove && item.status === 'approved' && connected,
    needsConnection: item.status === 'approved' && !connected,
    wordpress: connected
      ? `Connected to ${integration.config?.siteName || integration.config?.siteUrl || 'your WordPress site'}`
      : integration?.status === 'broken'
        ? 'The WordPress connection needs attention'
        : 'WordPress is not connected',
    pluginMissing: connected && !integration.config?.pluginConnected,
    cannotPublishLive: connected && integration.config?.canPublish === false,
    publishedUrl: item.status === 'published' ? item.publishedUrl : null,
    draftUrl: item.status === 'approved' && item.cmsRef ? item.publishedUrl : null,
  };
}

/** The partial draft the customer watches appear: always sanitized, because it is model output. */
export function liveDraftHtml(text) {
  return sanitizeBody(String(text ?? '').slice(-60_000)).html;
}

/** The finished HTML for a site that is not on WordPress: the page, then the structured data as a script block. */
export function exportHtml({ title, bodyHtml, jsonld }) {
  const head = `<!-- ${String(title).replace(/--/g, '—')} -->`;
  return `${head}\n${bodyHtml}\n${jsonld ? scriptTag(jsonld) : ''}\n`;
}

const MD_ESCAPE = /([\\`*_[\]])/g;

function inlineMarkdown($, node) {
  let out = '';
  for (const child of $(node).contents().toArray()) {
    if (child.type === 'text') out += child.data.replace(MD_ESCAPE, '\\$1');
    else if (child.type === 'tag') {
      const inner = inlineMarkdown($, child);
      if (child.name === 'strong') out += `**${inner}**`;
      else if (child.name === 'em') out += `*${inner}*`;
      else if (child.name === 'a' && child.attribs?.href)
        out += `[${inner}](${child.attribs.href.replace(/\)/g, '%29')})`;
      else if (child.name === 'br') out += '  \n';
      else out += inner;
    }
  }
  return out.replace(/[ \t]+/g, ' ');
}

/** The draft as Markdown, for a site whose editor takes it (headings, paragraphs, lists, quotes, tables, links). */
export function exportMarkdown(bodyHtml) {
  const $ = load(String(bodyHtml ?? ''), null, false);
  const blocks = [];
  for (const node of $.root().children().toArray()) {
    const name = node.name;
    if (/^h[2-4]$/.test(name))
      blocks.push(`${'#'.repeat(Number(name[1]))} ${inlineMarkdown($, node).trim()}`);
    else if (name === 'p') blocks.push(inlineMarkdown($, node).trim());
    else if (name === 'ul' || name === 'ol') {
      blocks.push(
        $(node)
          .children('li')
          .toArray()
          .map((li, i) => `${name === 'ol' ? `${i + 1}.` : '-'} ${inlineMarkdown($, li).trim()}`)
          .join('\n'),
      );
    } else if (name === 'blockquote') {
      blocks.push(
        inlineMarkdown($, node)
          .trim()
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n'),
      );
    } else if (name === 'table') {
      const rows = $(node)
        .find('tr')
        .toArray()
        .map((tr) =>
          $(tr)
            .children('th, td')
            .toArray()
            .map((cell) => inlineMarkdown($, cell).trim().replace(/\|/g, '\\|')),
        );
      if (rows.length) {
        const width = Math.max(...rows.map((r) => r.length));
        const pad = (r) => [...r, ...Array(width - r.length).fill('')];
        const lines = [
          `| ${pad(rows[0]).join(' | ')} |`,
          `| ${Array(width).fill('---').join(' | ')} |`,
          ...rows.slice(1).map((r) => `| ${pad(r).join(' | ')} |`),
        ];
        blocks.push(lines.join('\n'));
      }
    }
  }
  return `${blocks.join('\n\n')}\n`;
}

/** A short line for the board: how long the draft is. */
export const wordsLabel = (n) => `${Number(n).toLocaleString('en-US')} words`;

export const textWords = (html) => wordsOf(load(String(html ?? ''), null, false).text()).length;

import { DEFAULT_ENGINE_LABELS } from './narrative.js';
import {
  caseTitle,
  CAUSE_LABELS,
  METRICS,
  OPEN_STATUSES,
  outcomeSentence,
  RECOVERY,
  STATUS_LABELS,
} from './recovery.js';

/**
 * What the Recovery screens say (Milestone 14, task 14.07; UI_DESIGN screen D8). Pure: stored cases go in, the rows and
 * sentences come out, so every rule below is tested without a browser.
 *
 * The rules the screens keep:
 *   - A diagnosis is the code's, with the facts behind each cause shown. "We can't tell" is a result, said in those words,
 *     never dressed up as a guess, and never shown as "no cause".
 *   - "We could not look" is its own state. A fix we could not look at is "Couldn’t check", never "gone" and never "in place".
 *   - Nothing here is coloured as a recovery until the system closed the case as one.
 *   - A person cannot close a case or declare it recovered: there is no button for it.
 */

const date = (value) =>
  new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

const TONES = Object.freeze({
  diagnosing: 'warning',
  repairing: 'warning',
  recovered: 'success',
  closed_noise: 'success',
  closed_unknown: 'unknown',
});

const BAND_LABELS = Object.freeze({
  strong: 'Strong evidence',
  likely: 'Likely',
});

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const pct = (n, k) => (n > 0 ? `${Math.round((k / n) * 100)}%` : '—');

/** One row of the case list. */
export function caseRow(kase, { engineNames = DEFAULT_ENGINE_LABELS } = {}) {
  const named = kase.diagnosis?.outcome === 'named';
  return {
    id: kase.publicId,
    title: caseTitle(kase, engineNames),
    status: kase.status,
    statusLabel: STATUS_LABELS[kase.status],
    tone: TONES[kase.status],
    open: OPEN_STATUSES.includes(kase.status),
    opened: date(kase.openedAt),
    closed: kase.closedAt ? date(kase.closedAt) : null,
    summary: outcomeSentence({ ...kase, engineNames }),
    cause: named
      ? kase.diagnosis.causes.map((c) => c.label ?? CAUSE_LABELS[c.code]).join(', ')
      : kase.diagnosis
        ? 'We can’t tell yet'
        : 'Looking now',
  };
}

export function listView({ cases, engineNames }) {
  const rows = cases.map((c) => caseRow(c, { engineNames }));
  return {
    open: rows.filter((r) => r.open),
    closed: rows.filter((r) => !r.open),
    total: rows.length,
  };
}

/** What each timeline entry says. */
function timelineEntry(e) {
  const d = e.details ?? {};
  const base = { at: date(e.at), kind: e.kind };
  switch (e.kind) {
    case 'opened':
      return {
        ...base,
        title: 'We opened this case',
        text: `The figure fell significantly and was still low over the latest ${RECOVERY.recentDays} days (${pct(d.recent?.n, d.recent?.k)} of ${plural(d.recent?.n ?? 0, 'answer', 'answers')}).`,
      };
    case 'rechecked': {
      const fixes = d.fixes ?? [];
      const count = (live) => fixes.filter((f) => f.live === live).length;
      return {
        ...base,
        title: 'We looked at your site again',
        text: d.scanId
          ? `A new site check ran. Of ${plural(fixes.length, 'earlier fix', 'earlier fixes')}: ${count('present')} still in place, ${count('gone')} gone, ${count('unknown')} we couldn’t check.`
          : `We could not run a new site check. Of ${plural(fixes.length, 'earlier fix', 'earlier fixes')}: ${count('present')} still in place, ${count('gone')} gone, ${count('unknown')} we couldn’t check.`,
      };
    }
    case 'diagnosed':
      return {
        ...base,
        title:
          d.outcome === 'named' ? 'We found a likely cause' : 'We can’t tell what caused it yet',
        text:
          d.outcome === 'named'
            ? (d.causes ?? []).map((c) => CAUSE_LABELS[c.code]).join(', ')
            : 'None of the possible causes had two facts behind it. We look again with the next check.',
      };
    case 'repairs_linked':
      return {
        ...base,
        title: 'We linked the repairs',
        text: 'They are in your Actions list, where you approve them as usual.',
      };
    case 'recovered':
      return {
        ...base,
        title: 'The figure recovered',
        text: 'It is back inside its earlier range.',
      };
    case 'closed_noise':
      return {
        ...base,
        title: 'The figure came back on its own',
        text: 'Nothing was done about it and it is back inside its earlier range, so we closed the case.',
      };
    case 'closed_unknown':
      return {
        ...base,
        title: 'We closed the case without a cause',
        text: `The figure stayed down for ${RECOVERY.unknownAfterDays / 7} weeks and we could not tell why. A new decline opens a new case.`,
      };
    case 'alerted':
      return { ...base, title: 'We emailed you', text: 'The email says the decline has lasted.' };
    default:
      return { ...base, title: e.kind, text: '' };
  }
}

/** The "how the figure moved" rows: what it was, what it fell to, what it is now. Counts of answers, never bare rates. */
export function movement(kase, recent = kase.recent) {
  const row = (label, window, s) => ({
    label,
    window,
    rate: s.n > 0 ? pct(s.n, s.k) : '—',
    answers: s.n,
    state: s.n > 0 ? 'ok' : 'unknown',
  });
  return [
    row('Before', `${date(kase.baseline.start)} – ${date(kase.baseline.end)}`, kase.baseline),
    row('The fall', `${date(kase.decline.start)} – ${date(kase.decline.end)}`, kase.decline),
    row(
      `Now (last ${RECOVERY.recentDays} days)`,
      kase.closedAt ? `until ${date(kase.closedAt)}` : 'as of the latest check',
      recent,
    ),
  ];
}

const LIVE_TEXT = Object.freeze({
  present: { label: 'Still in place', tone: 'success' },
  gone: { label: 'No longer on your site', tone: 'warning' },
  unknown: { label: 'Couldn’t check', tone: 'unknown' },
});

/**
 * The case page.
 *
 * @param kase      `recovery.get()`
 * @param events    `recovery.events()`
 * @param progress  `recovery.repairProgress()`: `{ repairs: [{ kind, text, links: [...] }], repaired }`
 * @param fixTitles `{ [recommendationId]: title }` for the re-check's fixes
 */
export function caseView({
  kase,
  events,
  progress,
  fixTitles = {},
  engineNames = DEFAULT_ENGINE_LABELS,
}) {
  const open = OPEN_STATUSES.includes(kase.status);
  const closeRecent =
    kase.closeDetails && typeof kase.closeDetails.n === 'number' ? kase.closeDetails : null;
  const sentence = outcomeSentence({ ...kase, recent: closeRecent ?? kase.recent, engineNames });
  const diagnosis = kase.diagnosis;
  const named = diagnosis?.outcome === 'named';
  const recheck = kase.recheck;
  return {
    id: kase.publicId,
    title: caseTitle(kase, engineNames),
    metric: METRICS[kase.metric].label,
    status: kase.status,
    statusLabel: STATUS_LABELS[kase.status],
    tone: TONES[kase.status],
    open,
    opened: date(kase.openedAt),
    closed: kase.closedAt ? date(kase.closedAt) : null,
    sentence,
    movement: movement(kase, closeRecent ?? kase.recent),
    onset: kase.onsetDate ? date(kase.onsetDate) : null,
    // The "Recovered" proof card: only when the system closed it as a recovery, and only for a case somebody worked on.
    proof:
      kase.status === 'recovered'
        ? {
            title: 'Recovered',
            text: `${sentence} You made changes while it was down, and the figure is back inside its earlier range.`,
          }
        : kase.status === 'closed_noise'
          ? {
              title: 'Recovered by itself',
              text: `${sentence} We found nothing you did that explains it, so we do not call it a fix.`,
            }
          : null,
    diagnosis: !diagnosis
      ? {
          state: 'waiting',
          text: 'We are looking at your site and your recent changes. This usually takes a few minutes.',
        }
      : named
        ? {
            state: 'named',
            text: 'These are the likeliest causes. Each stands on at least two facts we found, and we list them so you can check.',
            causes: diagnosis.causes.map((c) => ({
              label: c.label ?? CAUSE_LABELS[c.code],
              band: BAND_LABELS[c.band],
              strong: c.band === 'strong',
              facts: c.facts.map((f) => f.text),
              against: (c.against ?? []).map((f) => f.text),
            })),
          }
        : {
            state: 'cant_tell',
            text: 'We can’t tell what caused this.',
            reason: diagnosis.reason,
            note: 'We would rather say that than guess. When the next check finishes we look again, and we keep watching the figure.',
          },
    recheck: recheck
      ? {
          scanned: Boolean(recheck.scanId) && recheck.scanStatus !== 'failed',
          fixes: (recheck.fixes ?? []).map((f) => ({
            title: fixTitles[String(f.recommendationId)] ?? 'An earlier fix',
            recommendationId: String(f.recommendationId),
            ...LIVE_TEXT[f.live],
          })),
        }
      : null,
    repairs: (progress?.repairs ?? []).map((r) => ({
      text: r.text,
      kind: r.kind,
      links: r.links ?? [],
      cause: CAUSE_LABELS[r.cause] ?? r.cause,
      siteChangeId: r.siteChangeId ?? null,
    })),
    repaired: Boolean(progress?.repaired),
    timeline: events.map(timelineEntry),
    seoSafe:
      'AEO Corner never blocks crawlers, removes noindex handling or changes a canonical address for you. Every repair here is an ordinary action you approve.',
  };
}

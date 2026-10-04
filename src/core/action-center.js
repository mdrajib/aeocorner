import { effortLabel } from './ice.js';
import { DEFAULT_ENGINE_LABELS } from './narrative.js';
import { HORIZONS, longDate, proofSentence } from './outcomes.js';
import { DISMISS_REASONS, MAX_VERIFY_ATTEMPTS, STATUS_LABELS } from './recommendation-lifecycle.js';
import { SIGNIFICANCE } from './significance.js';

/**
 * What the Action Center screens say (UI_DESIGN D1-D4, Milestone 6). Pure: a recommendation as the repository returns it
 * in, labels, copy and structured rows out, so the wording is tested and a template only lays it out.
 *
 * The rules the words follow:
 *   - A figure is only ever one the stored evidence or outcome contains. Nothing is rounded into a claim.
 *   - Only a result that passed the significance test is a "win" or a "decline", and only those two are coloured.
 *     "Not enough data" is its own thing and never reads as "no change".
 *   - A fix we could not check says so ("we could not check your site"); it is never described as failing.
 */

export const CATEGORY_LABELS = Object.freeze({
  crawler_access: 'AI crawler access',
  renderability: 'Renderability',
  structured_data: 'Structured data',
  entity: 'Brand clarity',
  content_new: 'New content',
  content_refresh: 'Content refresh',
  offsite_presence: 'Other websites',
  reputation: 'Reputation',
  technical: 'Technical',
});

export const FIX_PATH_LABELS = Object.freeze({
  auto_fix: 'Quick fix',
  content: 'Content',
  guidance: 'Guide',
});

/** Why a fix path has no button yet: one-click fixing and the Content Studio arrive with the WordPress connection. */
export const FIX_PATH_NOTES = Object.freeze({
  auto_fix:
    'This one can be applied for you once your WordPress site is connected. Until then, follow the steps below and mark it done when it is live.',
  content:
    'This one is best fixed with a page or a rewrite. The Content Studio will draft it for you; until then, follow the steps below and mark it done when it is published.',
  guidance: '',
});

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const BADGES = Object.freeze({
  open: { text: STATUS_LABELS.open, tone: 'neutral' },
  in_progress: { text: STATUS_LABELS.in_progress, tone: 'brand' },
  done: { text: STATUS_LABELS.done, tone: 'info' },
  verified: { text: STATUS_LABELS.verified, tone: 'success' },
  unverified: { text: STATUS_LABELS.unverified, tone: 'warning' },
  measuring: { text: STATUS_LABELS.measuring, tone: 'info' },
  proven_win: { text: STATUS_LABELS.proven_win, tone: 'success' },
  no_change: { text: STATUS_LABELS.no_change, tone: 'neutral' },
  declined: { text: STATUS_LABELS.declined, tone: 'danger' },
  dismissed: { text: STATUS_LABELS.dismissed, tone: 'neutral' },
});

/** A status as a badge. A fix that ended for lack of data is "Not enough data", in the "couldn't check" look. */
export function statusBadge(status, outcome = null) {
  if (status === 'no_change' && outcome?.verdict === 'insufficient_data') {
    return { text: 'Not enough data', tone: 'unknown' };
  }
  return BADGES[status] ?? { text: status, tone: 'neutral' };
}

const sentenceOf = (text) => {
  const first = String(text ?? '').split(/(?<=[.!?])\s+/)[0] ?? '';
  return first.length > 220 ? `${first.slice(0, 217).trimEnd()}…` : first;
};

/** One recommendation as a row of the list (D1). */
export function listItem(rec, { projectBase, brandName }) {
  const all = rec.questions === 0 || rec.ruleCode?.startsWith('readiness.');
  return {
    id: String(rec.id),
    href: `${projectBase}/actions/${rec.id}`,
    title: rec.title,
    status: rec.status,
    badge: statusBadge(rec.status, rec.outcome),
    category: CATEGORY_LABELS[rec.category] ?? rec.category,
    fixPath: FIX_PATH_LABELS[rec.fixPath] ?? rec.fixPath,
    effort: effortLabel(rec.effort),
    reach: all
      ? 'Affects all your questions'
      : `Affects ${plural(rec.questions, 'question', 'questions')}`,
    teaser: sentenceOf(rec.whyMd),
    // The rule stopped finding it: probably fixed on the site. A person confirms, because we may be wrong.
    looksFixed: Boolean(rec.signalClearedAt) && ['open', 'in_progress'].includes(rec.status),
    changedOn: longDate(rec.statusChangedAt),
    // What the latest before/after check found, in words (a result row only).
    result: rec.outcome
      ? proofSentence(rec.outcome, {
          title: rec.title,
          startedAt: rec.measuringStartedAt ?? rec.doneAt ?? rec.statusChangedAt,
          questions: rec.outcome.promptsCount,
          brandName: brandName ?? 'You',
        })
      : null,
  };
}

/** Paragraphs of a stored `why_md`: text separated by blank lines. Never markup. */
export const paragraphsOf = (md) =>
  String(md ?? '')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

/** The steps of a stored `steps_md` ("1. Do this" per line), without their numbers. */
export const stepsOf = (md) =>
  String(md ?? '')
    .split('\n')
    .map((line) => line.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean);

/**
 * What the evidence says, as labelled rows for the detail screen: `[{ label, text, href? }]`. Only what the evidence
 * holds; the same facts the narrative was written from.
 */
export function evidenceRows(
  rec,
  { projectBase, domain, brandName, engineLabel = (c) => DEFAULT_ENGINE_LABELS[c] ?? c },
) {
  const e = rec.evidence ?? {};
  const rows = [];
  if (e.type === 'readiness') {
    const c = e.check;
    rows.push({ label: 'What we checked', text: `${c.title} (check ${c.code})` });
    rows.push({ label: 'Result', text: `${c.points} of ${c.possible} points` });
    if (c.summary) rows.push({ label: 'What the scan saw', text: c.summary });
    if (e.scannedAt) rows.push({ label: 'Scanned', text: `${domain} on ${longDate(e.scannedAt)}` });
  } else if (e.type === 'lost_prompt') {
    rows.push({
      label: 'The question',
      text: e.question,
      href: `${projectBase}/answers/${e.promptId}`,
    });
    rows.push({
      label: 'Answers we read',
      text: `${plural(e.answersRead, 'answer', 'answers')} from ${(e.engines ?? []).map(engineLabel).join(', ')}`,
    });
    rows.push({ label: `${brandName} was named`, text: 'in none of them' });
    if (e.competitors?.length) {
      rows.push({
        label: 'Named instead',
        text: e.competitors.map((r) => `${r.name} (${plural(r.k, 'time', 'times')})`).join(', '),
      });
    }
  } else if (e.type === 'cited_source') {
    rows.push({
      label: 'The site',
      text: `${e.domain}${e.siteType ? ` (${String(e.siteType).toLowerCase()})` : ''}`,
      href: `${projectBase}/citations`,
    });
    rows.push({
      label: 'Cited',
      text: `${plural(e.timesCited, 'time', 'times')}, in ${plural(e.answersCiting, 'answer', 'answers')}`,
    });
    rows.push({
      label: `Answers that did not name ${brandName}`,
      text: String(e.answersWithoutBrand),
    });
  } else if (e.type === 'sentiment') {
    rows.push({
      label: 'Average sentiment',
      text: `${e.average} on a scale from -2 (very negative) to 2 (very positive)`,
    });
    rows.push({ label: 'Answers that name the brand', text: String(e.answers) });
    rows.push({
      label: 'Where to look',
      text: 'The latest answers',
      href: `${projectBase}/answers`,
    });
  } else if (e.type === 'entity_fact') {
    rows.push({ label: 'What you told us', text: `${e.label}: ${e.expected}` });
    rows.push({
      label: 'What engines said',
      text: `${plural(e.wrong, 'statement', 'statements')} disagreed with you${e.right ? `, ${plural(e.right, 'statement', 'statements')} agreed` : ''}, in ${plural(e.answersRead, 'answer', 'answers')}`,
      href: `${projectBase}/entity`,
    });
    for (const x of e.examples ?? []) {
      rows.push({ label: engineLabel(x.engine), text: `“${x.said}”` });
    }
  } else if (e.type === 'entity_profile') {
    rows.push({ label: 'The profile', text: `${e.platformLabel}: ${e.url}`, href: e.url });
    rows.push({
      label: 'What we saw',
      text:
        e.finding === 'not_found'
          ? 'The page answered “not found”'
          : `The page loads but does not name ${brandName}${e.linksBack === false ? ' and does not link to your site' : ''}`,
      href: `${projectBase}/entity`,
    });
    if (e.checkedAt) rows.push({ label: 'Checked', text: longDate(e.checkedAt) });
  } else if (e.type === 'entity_wikidata') {
    rows.push({
      label: 'What we found',
      text:
        e.finding === 'not_in_wikidata'
          ? 'Wikidata has no item for your business'
          : e.finding === 'ambiguous'
            ? `${plural(e.candidates, 'item', 'items')} with your name, none we can tie to ${domain}`
            : `The item ${e.givenId ?? ''} in your Brand Kit does not look like ${brandName}`,
      href: `${projectBase}/entity`,
    });
    if (e.checkedAt) rows.push({ label: 'Checked', text: longDate(e.checkedAt) });
  }
  return rows;
}

const attemptWords = (a) =>
  a.status === 'passed'
    ? 'passed'
    : a.status === 'pending'
      ? 'waiting'
      : a.details?.couldntCheck
        ? 'could not check'
        : 'problem still there';

/**
 * The panel under the title: what is happening to this recommendation and what the person can do. Says nothing the
 * stored state does not support.
 *
 * @param detail  `recommendations.get()`: `{ recommendation, prompts, events, verifications, outcomes }`
 * @returns `{ tone, title, text, attempts: [{ label, text }], facts: [{ label, text }] }`
 */
export function statusPanel(detail) {
  const rec = detail.recommendation;
  const baseline = rec.baseline;
  const attempts = (detail.verifications ?? []).map((a) => ({
    label: `Check ${a.attempt} of ${MAX_VERIFY_ATTEMPTS}`,
    text: attemptWords(a),
  }));
  const facts = [];
  if (baseline && rec.status !== 'open' && rec.status !== 'in_progress') {
    facts.push({
      label: 'Before the fix',
      text:
        baseline.n === 0
          ? 'No readable answers yet, so there is nothing to compare with'
          : `${baseline.k} of ${plural(baseline.n, 'answer', 'answers')} named you`,
    });
  }
  switch (rec.status) {
    case 'open':
      return {
        tone: 'info',
        title: 'Ready when you are',
        text: 'Start it to keep track, or mark it done if you have already made this change.',
        attempts,
        facts,
      };
    case 'in_progress':
      return {
        tone: 'info',
        title: 'In progress',
        text: 'When the change is live, press “Mark as done”. We check your site straight away and measure what happens next.',
        attempts,
        facts,
      };
    case 'done':
    case 'verified':
      return {
        tone: 'info',
        title: 'We are checking your site',
        text: 'The first check runs now, then again after an hour and after a day, because a change can take a little while to show. This page updates by itself.',
        attempts,
        facts,
      };
    case 'unverified': {
      const reason = rec.verification?.reason;
      return {
        tone: 'warning',
        title: 'We could not confirm the fix',
        text:
          reason === 'couldnt_check'
            ? 'We could not reach your site to check, so we do not know whether the change is live. If you are sure it is, start measuring and we will compare your answers before and after.'
            : 'We checked your site and the problem is still there. Make sure the change is live (and that any cache has cleared), or, if you are sure it is in place, start measuring anyway.',
        attempts,
        facts,
      };
    }
    case 'measuring': {
      const started = rec.measuringStartedAt;
      if (started) {
        for (const [key, def] of Object.entries(HORIZONS)) {
          const due = new Date(new Date(started).getTime() + def.days * 86_400_000);
          const done = (detail.outcomes ?? []).some((o) => o.horizon === key);
          facts.push({
            label: `Check at ${def.label}`,
            text: done ? 'done' : longDate(due),
          });
        }
      }
      const notVerifiable = rec.verification?.reason === 'not_verifiable';
      return {
        tone: 'info',
        title: 'We are measuring the effect',
        text: `${
          notVerifiable
            ? 'We cannot check this kind of fix automatically, so marking it done was our cue. '
            : 'Your site has the fix. '
        }We count how often the engines name you on the questions this affects, and compare it with the weeks before. Answers often take 2–6 weeks to change, so judging earlier would be guessing.`,
        attempts,
        facts,
      };
    }
    case 'dismissed':
      return {
        tone: 'info',
        title: 'Dismissed',
        text: `${DISMISS_REASONS[rec.dismissReason] ?? 'Dismissed'}.${rec.dismissNote ? ` “${rec.dismissNote}”` : ''} We will not suggest it again for a while.`,
        attempts,
        facts,
      };
    default:
      return {
        tone: 'info',
        title: STATUS_LABELS[rec.status] ?? rec.status,
        text: '',
        attempts,
        facts,
      };
  }
}

/**
 * The proof card for each outcome (D4): the sentence, and the figures behind it. A result that did not pass the test is
 * never in the colours of a win.
 */
export function proofCards(detail, { brandName }) {
  const rec = detail.recommendation;
  return (detail.outcomes ?? []).map((o) => {
    const sentence = proofSentence(o, {
      title: rec.title,
      startedAt: rec.measuringStartedAt ?? rec.doneAt,
      questions: o.promptsCount,
      brandName,
    });
    const rows = [
      {
        label: 'Before',
        text: `${o.kBefore} of ${plural(o.nBefore, 'answer', 'answers')} named ${brandName}${o.rateBefore == null ? '' : ` (${Math.round(o.rateBefore * 1000) / 10}%)`}`,
      },
      {
        label: 'After',
        text: `${o.kAfter} of ${plural(o.nAfter, 'answer', 'answers')} named ${brandName}${o.rateAfter == null ? '' : ` (${Math.round(o.rateAfter * 1000) / 10}%)`}`,
      },
    ];
    if (o.deltaPp != null)
      rows.push({
        label: 'Change',
        text: `${o.deltaPp > 0 ? '+' : ''}${o.deltaPp} percentage points`,
      });
    const sure =
      o.verdict === 'insufficient_data'
        ? `We need at least ${SIGNIFICANCE.minAnswers} readable answers before and after to say anything. This check is not a result either way.`
        : o.p == null
          ? ''
          : `We call a change real only if it is at least ${SIGNIFICANCE.minDeltaPp} points and a statistical test (p < ${SIGNIFICANCE.alpha}) says it is unlikely to be chance. Here p ${o.p < 0.001 ? '< 0.001' : `= ${Math.round(o.p * 1000) / 1000}`}.`;
    return {
      id: o.id == null ? null : String(o.id),
      horizon: HORIZONS[o.horizon]?.label ?? o.horizon,
      verdict: o.verdict,
      tone:
        o.verdict === 'proven_win'
          ? 'success'
          : o.verdict === 'declined'
            ? 'danger'
            : o.verdict === 'insufficient_data'
              ? 'unknown'
              : 'neutral',
      label:
        o.verdict === 'proven_win'
          ? 'Proven win'
          : o.verdict === 'declined'
            ? 'Declined'
            : o.verdict === 'insufficient_data'
              ? 'Not enough data'
              : 'Within normal variation',
      sentence,
      rows,
      sure,
      computedOn: longDate(o.computedAt),
    };
  });
}

/** What a person did, or the system did, as a line of the history. */
export function historyLines(events) {
  const who = { user: 'You', staff: 'AEO Corner team', system: 'AEO Corner' };
  return events.map((e) => ({
    when: longDate(e.createdAt),
    who: who[e.actorType] ?? 'AEO Corner',
    what:
      e.fromStatus == null
        ? 'Raised'
        : `${STATUS_LABELS[e.fromStatus] ?? e.fromStatus} → ${STATUS_LABELS[e.toStatus] ?? e.toStatus}`,
    note: e.note ?? '',
  }));
}

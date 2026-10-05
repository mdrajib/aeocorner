import { describeChange, staleNotice } from './dashboard.js';
import { caseTitle } from './recovery.js';

/**
 * The weekly digest as data (Milestone 8, task 8.13; UI_DESIGN E2, CUSTOMER_JOURNEY stage 7). Pure: figures, changes and
 * actions come in, the content of one email goes out. The email template only lays it out.
 *
 * The rules the dashboard keeps are kept here too: a figure we could not read is "Couldn’t check", never 0; a change is
 * shown as good or bad only when it passed the significance test; a week with nothing to report says so plainly instead of
 * inventing news.
 */

const FIGURES = [
  ['mentionRate', 'How often AI names you'],
  ['shareOfVoice', 'Your share of voice'],
  ['visibility', 'Your visibility score'],
];

const MAX_CHANGES = 4;
const MAX_ACTIONS = 3;

/** One figure as the email shows it. */
function figure(label, tile) {
  if (!tile || tile.state === 'unknown') {
    return { label, display: '—', note: 'Couldn’t check this week', tone: 'neutral' };
  }
  if (tile.state === 'empty') {
    return { label, display: '—', note: tile.note, tone: 'neutral' };
  }
  const change = tile.change;
  const tone = change?.significant ? (change.direction === 'up' ? 'success' : 'danger') : 'neutral';
  return { label, display: tile.display, note: change?.text ?? null, tone };
}

/**
 * @param {object} input
 * @param {{ name: string, domain: string }} input.project
 * @param {object} input.tiles          `headline().tiles`
 * @param {boolean} input.hasData       `headline().hasData`
 * @param {object[]} [input.events]     `change_events` rows from the last seven days, significant ones only
 * @param {object[]} [input.actions]    the best open recommendations: `{ title, why? }`
 * @param {object[]} [input.wins]       before/after proofs that were won this week: `{ sentence }`
 * @param {object[]} [input.cases]      recovery cases (core/recovery.js): the open ones, and any closed in the last seven days
 * @param {number} [input.autopilotReady]  items Autopilot prepared that wait for a person (0 says nothing)
 * @param {Date|string|null} [input.lastFinishedAt]  when the newest finished check ended
 * @param {object} [input.engineNames]
 * @param {object} [input.entityNames]
 * @param {Date} [input.now]
 */
export function buildDigest({
  project,
  tiles,
  hasData,
  events = [],
  actions = [],
  wins = [],
  cases = [],
  autopilotReady = 0,
  lastFinishedAt = null,
  engineNames = {},
  entityNames = {},
  now = new Date(),
}) {
  const notices = [];
  const stale = staleNotice(lastFinishedAt, now);
  if (stale) notices.push({ tone: 'warning', title: stale.title, text: stale.text });

  // A decline we are looking into is told in every digest until it ends; a recovery is told once, the week it happens.
  const weekAgo = now.getTime() - 7 * 86_400_000;
  for (const k of cases) {
    const title = caseTitle(k, engineNames);
    if (k.status === 'diagnosing' || k.status === 'repairing') {
      notices.push({
        tone: 'warning',
        title: 'A decline is being looked at.',
        text: `${title}. Open the recovery case to see what we found and what to do.`,
      });
    } else if (
      (k.status === 'recovered' || k.status === 'closed_noise') &&
      k.closedAt &&
      new Date(k.closedAt).getTime() >= weekAgo
    ) {
      notices.push({
        tone: 'success',
        title: 'A decline has recovered.',
        text: `${title}: the figure is back inside its earlier range.`,
      });
    }
  }

  // What Autopilot prepared is waiting for a person; the email only points at the sign-in screen where it is approved.
  if (autopilotReady > 0) {
    notices.push({
      tone: 'info',
      title: `${autopilotReady} ${autopilotReady === 1 ? 'change is' : 'changes are'} ready for your approval.`,
      text: 'Sign in and open Autopilot to read each one. Nothing changes on your site until you approve it.',
    });
  }

  const figures = hasData ? FIGURES.map(([key, label]) => figure(label, tiles[key])) : [];

  const changes = events
    .filter((e) => e.is_significant)
    .map((e) => ({
      event: e,
      described: describeChange(e, { entityName: entityNames[String(e.entity_id)], engineNames }),
    }))
    // The all-engines events say it; per-engine ones only add noise to an email.
    .filter(({ event }) => event.engine_code === null)
    .slice(0, MAX_CHANGES)
    .map(({ described }) => described);

  const topActions = actions
    .slice(0, MAX_ACTIONS)
    .map((a) => ({ title: a.title, why: a.why ?? null }));
  const proofs = wins
    .slice(0, 2)
    .map((w) =>
      (w.sentence ?? w.metric === 'citation_share')
        ? `“${w.title}” is working: on its questions the brand’s own site was ${w.kBefore} of ${w.nBefore} cited sources before, and ${w.kAfter} of ${w.nAfter} since.`
        : `“${w.title}” is working: on its questions the brand was named in ${w.kBefore} of ${w.nBefore} answers before, and in ${w.kAfter} of ${w.nAfter} since.`,
    );

  const hasNews = changes.length > 0 || proofs.length > 0;
  let headlineText;
  if (!hasData) {
    headlineText = 'We could not read any answers this week.';
  } else if (changes.some((c) => c.tone === 'danger')) {
    headlineText = 'Something dropped this week. Here is what changed.';
  } else if (changes.some((c) => c.tone === 'success') || proofs.length) {
    headlineText = 'Good news this week.';
  } else {
    headlineText = 'A steady week: nothing changed beyond normal variation.';
  }

  return {
    subject: hasNews
      ? `${project.name}: ${changes[0]?.title ?? 'a fix is working'}`
      : `${project.name}: your weekly AI visibility update`,
    preheader: hasData
      ? `${figures[0]?.label}: ${figures[0]?.display}. ${headlineText}`
      : headlineText,
    headline: headlineText,
    project: { name: project.name, domain: project.domain },
    hasData,
    figures,
    changes,
    actions: topActions,
    proofs,
    notices,
    autopilotReady,
    hasNews,
  };
}

import { ENGINE_LABELS } from './engines.js';
import { FINDINGS, isSelfConfirmed } from './entity-checks.js';
import { checkFacts, statedFacts } from './entity-accuracy.js';
import { checklists } from './entity-guidance.js';
import { platformLabel } from './entity-profiles.js';

/**
 * What the Entity screen says (Milestone 12, task 12.09, UI_DESIGN screen D7). Pure: the Brand Kit, the stored checks and
 * what the engines said go in, the rows and sentences come out, so every rule below is tested without a browser.
 *
 * The rules the screen keeps:
 *   - "We could not look" is `unknown` ("Couldn’t check"), never a failure and never green. A profile that passed last week
 *     and could not be checked today stays "Confirmed", with a note saying so.
 *   - "Not mentioned" is neutral, not a problem: engines are only wrong when they SAY something different.
 *   - A fact with no brand answer read behind it is `unknown`, not "not mentioned".
 */

const date = (value) =>
  new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

const wikidataUrl = (id) => `https://www.wikidata.org/wiki/${id}`;

/** The row of one listed profile: what it is, how it was last checked, and what that means in words. */
export function profileRow(profile, check) {
  const row = {
    platform: platformLabel(profile.platform),
    url: profile.url,
    tone: 'unknown',
    status: 'Not checked yet',
    detail: 'We check each profile every week. Press “Check now” to look straight away.',
    checkedOn: null,
    note: null,
    confirmed: false,
    selfConfirmed: false,
    canConfirm: false,
  };
  if (!check) return row;
  row.checkedOn = date(check.checkedAt);
  const d = check.details ?? {};
  if (check.status === 'passed') {
    row.tone = 'success';
    row.status = 'Confirmed';
    row.confirmed = true;
    row.detail =
      d.linksBack === false
        ? 'The page names your business, but does not link to your website. Add your website to the profile.'
        : 'The page names your business and links to your website.';
  } else if (check.status === 'failed') {
    row.tone = 'warning';
    row.status = check.finding === 'not_found' ? 'Page not found' : 'Doesn’t name you';
    row.detail = FINDINGS[check.finding] ?? 'The page did not pass our check.';
  } else if (isSelfConfirmed(check)) {
    row.tone = 'info';
    row.status = 'Confirmed by you';
    row.confirmed = true;
    row.selfConfirmed = true;
    row.detail = `${FINDINGS[check.finding] ?? 'We could not look at this page.'} You told us on ${date(check.confirmedAt)} that you checked it yourself and it describes your business. This is your statement, not our check.`;
  } else {
    row.tone = 'unknown';
    row.status = 'Couldn’t check';
    row.detail = FINDINGS[check.finding] ?? 'We could not look at this page.';
    // We were not allowed or not able to read it, so only a person can say what it shows.
    row.canConfirm = true;
  }
  if (check.status !== 'error' && d.lastAttempt) {
    row.note = `We could not check again on ${date(d.lastAttempt.at)}: ${String(
      FINDINGS[d.lastAttempt.finding] ?? 'we could not look',
    )
      .replace(/\.$/, '')
      .toLowerCase()}. This result is from ${row.checkedOn}.`;
  }
  return row;
}

/** The Wikidata card. */
export function wikidataCard(check, { wikidataId = '' } = {}) {
  const card = {
    tone: 'unknown',
    status: 'Not checked yet',
    detail: 'We look this up every week. Press “Check now” to look straight away.',
    item: null,
    itemUrl: null,
    givenId: wikidataId || null,
    checkedOn: null,
    note: null,
  };
  if (!check) return card;
  card.checkedOn = date(check.checkedAt);
  const item = check.details?.item;
  if (check.status === 'passed') {
    card.tone = 'success';
    card.status = 'Found';
    card.detail = FINDINGS[check.finding];
    if (item?.id) {
      card.item = `${item.label || item.id}${item.description ? `: ${item.description}` : ''} (${item.id})`;
      card.itemUrl = wikidataUrl(item.id);
    }
  } else if (check.status === 'failed') {
    card.tone = 'warning';
    card.status =
      check.finding === 'not_in_wikidata'
        ? 'No item'
        : check.finding === 'ambiguous'
          ? 'Can’t tell which is yours'
          : 'Doesn’t look like you';
    card.detail = FINDINGS[check.finding];
    if (wikidataId) card.itemUrl = wikidataUrl(wikidataId);
  } else {
    card.status = 'Couldn’t check';
    card.detail = FINDINGS[check.finding] ?? FINDINGS.lookup_failed;
  }
  if (check.status !== 'error' && check.details?.lastAttempt) {
    card.note = `We could not check again on ${date(check.details.lastAttempt.at)}. This result is from ${card.checkedOn}.`;
  }
  return card;
}

const engineLabel = (code) => ENGINE_LABELS[code] ?? code;

const FACT_STATUS = {
  wrong: { tone: 'warning', text: 'Engines disagree' },
  right: { tone: 'success', text: 'Engines agree' },
  not_mentioned: { tone: 'neutral', text: 'Not mentioned yet' },
  unknown: { tone: 'unknown', text: 'Couldn’t check' },
};

/** The accuracy table: one row per fact the customer stated. */
export function factRows(accuracy) {
  return accuracy.facts.map((f) => {
    const s = FACT_STATUS[f.status];
    const engines = Object.entries(f.engines)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([code, n]) => `${engineLabel(code)}: ${n.right} agree, ${n.wrong} disagree`);
    return {
      key: f.key,
      label: f.label,
      expected: f.expected,
      tone: s.tone,
      status: s.text,
      detail:
        f.status === 'unknown'
          ? 'No answer to a question about you has been read yet.'
          : f.status === 'not_mentioned'
            ? 'No answer we read stated this. That is not a problem: engines are only wrong when they say something different.'
            : `${f.wrong} statement${f.wrong === 1 ? '' : 's'} disagreed with you and ${f.right} agreed.`,
      engines,
      examples: f.examples.map((e) => ({ engine: engineLabel(e.engine), said: e.said })),
    };
  });
}

/**
 * The whole screen.
 *
 * @param {object} p
 * @param {object|null} p.kit        the current Brand Kit data
 * @param {object[]} p.checks        `entityChecks.checks()`
 * @param {{claims, answersRead}} p.said   `entityChecks.accuracyInputs()`
 * @param {string} p.domain
 */
export function entityView({ kit, checks, said, domain, country = '' }) {
  const listed = kit?.entity?.profiles ?? [];
  const byUrl = new Map(checks.filter((c) => c.kind === 'profile').map((c) => [c.subject, c]));
  const profiles = listed.map((p) => profileRow(p, byUrl.get(p.url)));
  const wikidata = wikidataCard(
    checks.find((c) => c.kind === 'wikidata'),
    {
      wikidataId: kit?.entity?.wikidataId,
    },
  );
  const accuracy = kit
    ? checkFacts({ kit, claims: said.claims, answersRead: said.answersRead })
    : { answersRead: 0, facts: [] };
  const facts = factRows(accuracy);
  const missing = [];
  if (kit) {
    const stated = statedFacts(kit);
    if (!stated.founded) missing.push('the year you were founded');
    if (!stated.headquarters) missing.push('where you are based');
    if (!stated.price) missing.push('a price on at least one offering');
  }

  const confirmed = profiles.filter((p) => p.confirmed).length;
  // Only a profile with a real result counts as looked at: a page that blocked us says nothing either way.
  const looked = profiles.filter(
    (p) => p.tone === 'success' || p.tone === 'warning' || p.selfConfirmed,
  ).length;
  const rightFacts = facts.filter((f) => f.tone === 'success').length;
  const wrongFacts = facts.filter((f) => f.tone === 'warning').length;
  return {
    hasKit: Boolean(kit),
    profiles,
    wikidata,
    facts,
    answersRead: accuracy.answersRead,
    missing,
    checklists: kit ? checklists(kit, { domain, country }) : [],
    tiles: {
      // With nothing listed or nothing looked at there is no figure: "couldn't check", never 0.
      profiles:
        listed.length && looked
          ? { value: `${confirmed} of ${listed.length}`, note: 'Profiles confirmed' }
          : null,
      wikidata: wikidata.tone === 'unknown' ? null : { value: wikidata.status },
      facts:
        facts.length && accuracy.answersRead
          ? {
              value: wrongFacts ? `${wrongFacts} to fix` : rightFacts ? 'All agree' : 'None stated',
              note: `${accuracy.answersRead} answer${accuracy.answersRead === 1 ? '' : 's'} read`,
            }
          : null,
    },
  };
}

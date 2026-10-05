import { createHash } from 'node:crypto';
import { isAutofixable } from './autofix.js';
import { canonicalJson } from './canonical-json.js';

/**
 * Autopilot (Milestone 15, ADR-0016). Pure: which of a project's open recommendations the weekly tick should prepare, and
 * what that preparation may and may not do. Nothing here touches a database, a site or a model.
 *
 * Option A of founder decision F1: Autopilot PREPARES, a person APPROVES. So this file can only say "prepare this"; there is
 * no function here that approves, applies or publishes anything, and `PREPARES` lists the only two things the tick may do.
 *
 * The same state always prepares the same items: candidates are ranked by ICE then by ID, the limits are counted from what
 * is already stored, and an item's identity is (recommendation, basis), so a second tick for the same week prepares nothing.
 */

export const AUTOPILOT = Object.freeze({
  /** Content drafts a project's owner may let it start in a week, unless they choose another number. */
  defaultWeeklyDrafts: 2,
  maxWeeklyDrafts: 10,
  /** Fixes the plugin can write that it prepares in a week. */
  maxFixesPerWeek: 3,
  /** Items prepared in one UTC day, however many runs and scans asked. */
  maxPerDay: 3,
  /** Items waiting for a person at once. A full inbox means nothing more is prepared until someone decides. */
  maxReady: 6,
  /** A ready item nobody opened is withdrawn after this long. The evidence it rested on has moved on. */
  readyExpiresDays: 28,
});

/** The only two things the tick may do. Approving, applying and publishing are not on the list, by design. */
export const PREPARES = Object.freeze({
  auto_fix: 'works out the exact change and keeps its fingerprint; nothing is sent to the site',
  content:
    'starts a draft in the Content Studio and lets it run to the quality check; nothing is published',
});

export const KINDS = Object.freeze(['auto_fix', 'content']);

export const STATUS_LABELS = Object.freeze({
  ready: 'Ready for you',
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'No longer needed',
});

/** Why a person turned an item down. `not_useful` and `wrong_content` lower the rule's confidence; the others say nothing about it. */
export const REJECT_REASONS = Object.freeze({
  not_useful: 'This is not useful for us',
  wrong_content: 'What was prepared is wrong',
  not_now: 'Not now',
  other: 'Something else',
});
export const LOWERS_CONFIDENCE = Object.freeze(['not_useful', 'wrong_content']);

/** Why a tick prepared nothing, in words a customer can read. */
export const SKIP_TEXT = Object.freeze({
  off: 'Autopilot is off for this project.',
  paused: 'Autopilot is paused.',
  plan: 'Your plan does not include Autopilot.',
  switched_off: 'Autopilot is switched off for now.',
  access: 'Your account is not collecting right now.',
  spend_paused: 'Collection is paused because the daily spend cap was reached.',
  inbox_full: 'The inbox is full. Decide on what is waiting and Autopilot prepares more.',
  limit_today: 'Autopilot has prepared enough for today.',
  nothing: 'Nothing needed preparing this week.',
});

const PREPARED_RE = /^\d{4}-W\d{2}$/;
export const isWeekKey = (value) => PREPARED_RE.test(String(value ?? ''));

/**
 * What a recommendation rested on. A new hash is new evidence: the rule's key, the pages it names and, for a citation gap, the
 * format of the pages cited. A re-raised recommendation is a new row and therefore a new item whatever this says.
 */
export function basisOf(rec) {
  const urls = [...(Array.isArray(rec.affectedUrls) ? rec.affectedUrls : [])].map(String).sort();
  return createHash('sha256')
    .update(
      canonicalJson({
        rule: rec.ruleCode,
        key: rec.stableKey ?? null,
        urls,
        format: rec.evidence?.contentFormat ?? null,
      }),
    )
    .digest('hex');
}

/** What Autopilot could prepare for a recommendation: a fix the plugin can write, a draft, or nothing. */
export function pathOf(rec) {
  if (isAutofixable(rec.ruleCode)) return 'auto_fix';
  if (rec.fixPath === 'content') return 'content';
  return null;
}

const compareIds = (a, b) => {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/**
 * Choose what to prepare now.
 *
 * @param {object} p
 * @param {object} p.settings          `{ enabled, allowAutoFix, allowContent, weeklyDrafts, pausedAt }`
 * @param {boolean} p.planAllows       the plan has the Autopilot feature
 * @param {boolean} p.flagOn           the staff switch (`autopilot`) is on for this organization
 * @param {boolean} p.collecting       the account may collect (not paused, read-only or ended)
 * @param {boolean} p.spendPaused      collection is paused by the daily spend cap
 * @param {boolean} p.pluginReady      the WordPress plugin is connected (only a fix needs it)
 * @param {object[]} p.recommendations open recommendations: `{ id, ruleCode, stableKey, fixPath, ice, status, signalClearedAt, affectedUrls, evidence }`
 * @param {object[]} p.items           what already exists: `{ recommendationId, basisHash, kind, status, weekKey, createdAt }`
 * @param {string} p.weekKey           the ISO week being prepared for
 * @param {Date} p.now
 * @param {number|null} p.draftsLeft   what is left of the month's draft allowance (null: not enforced)
 * @returns {{ skipped: string|null, picks: Array<{ rec: object, kind: string, basis: string }>, left: object }}
 */
export function planTick({
  settings,
  planAllows,
  flagOn,
  collecting = true,
  spendPaused = false,
  pluginReady = false,
  recommendations,
  items,
  weekKey,
  now,
  draftsLeft = null,
}) {
  const none = (skipped) => ({ skipped, picks: [], left: {} });
  if (!flagOn) return none('switched_off');
  if (!planAllows) return none('plan');
  if (!settings?.enabled) return none('off');
  if (settings.pausedAt) return none('paused');
  if (!collecting) return none('access');
  if (spendPaused) return none('spend_paused');

  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // Everything ever prepared counts against the limits, whatever became of it: the work, and a draft's cost, were done.
  const made = items;
  const ready = items.filter((i) => i.status === 'ready').length;
  const today = made.filter((i) => new Date(i.createdAt).getTime() >= dayStart).length;
  const thisWeek = made.filter((i) => i.weekKey === weekKey);
  const fixesThisWeek = thisWeek.filter((i) => i.kind === 'auto_fix').length;
  const draftsThisWeek = thisWeek.filter((i) => i.kind === 'content').length;

  const room = {
    inbox: Math.max(0, AUTOPILOT.maxReady - ready),
    today: Math.max(0, AUTOPILOT.maxPerDay - today),
    fixes:
      settings.allowAutoFix && pluginReady
        ? Math.max(0, AUTOPILOT.maxFixesPerWeek - fixesThisWeek)
        : 0,
    drafts: settings.allowContent
      ? Math.max(
          0,
          Math.min(
            settings.weeklyDrafts - draftsThisWeek,
            draftsLeft == null ? Number.POSITIVE_INFINITY : Math.floor(draftsLeft),
          ),
        )
      : 0,
  };
  if (room.inbox === 0) return { ...none('inbox_full'), left: room };
  if (room.today === 0) return { ...none('limit_today'), left: room };

  const known = new Set(items.map((i) => `${i.recommendationId}:${i.basisHash}`));
  const candidates = recommendations
    .filter((r) => r.status === 'open' && r.signalClearedAt == null)
    .map((rec) => ({ rec, kind: pathOf(rec), basis: basisOf(rec) }))
    .filter((c) => c.kind !== null && !known.has(`${c.rec.id}:${c.basis}`))
    .sort((a, b) => Number(b.rec.ice) - Number(a.rec.ice) || compareIds(a.rec.id, b.rec.id));

  const picks = [];
  let { inbox, today: day, fixes, drafts } = room;
  for (const c of candidates) {
    if (inbox === 0 || day === 0) break;
    if (c.kind === 'auto_fix') {
      if (fixes === 0) continue;
      fixes -= 1;
    } else {
      if (drafts === 0) continue;
      drafts -= 1;
    }
    inbox -= 1;
    day -= 1;
    picks.push(c);
  }
  return { skipped: picks.length ? null : 'nothing', picks, left: { ...room, fixes, drafts } };
}

/**
 * Should a ready item still be shown? The system withdraws one whose recommendation is no longer open, whose basis changed,
 * or that nobody opened for a long time. Returns the reason, or null when it stands.
 */
export function withdrawalReason(item, rec, { now }) {
  if (!rec) return 'The recommendation is gone.';
  if (['dismissed'].includes(rec.status)) return 'You dismissed the recommendation.';
  if (!['open', 'in_progress'].includes(rec.status)) return 'The fix was done another way.';
  if (rec.signalClearedAt != null) return 'The problem is no longer showing.';
  if (basisOf(rec) !== item.basisHash)
    return 'The evidence changed, so what was prepared no longer matches.';
  const age = now.getTime() - new Date(item.createdAt).getTime();
  if (age > AUTOPILOT.readyExpiresDays * 86_400_000) return 'Nobody opened it for four weeks.';
  return null;
}

/**
 * Rule-level calibration from people's own answers: each approval is a vote that the rule is right for this project, each
 * "not useful" or "wrong" rejection a vote that it is not. The pull is slow and bounded like the outcome calibration: the
 * prior counts as ten observations and a rule never loses more than half its confidence to rejections alone.
 */
export function rejectionAdjustedConfidence(confidence, { rejected = 0, accepted = 0 } = {}) {
  if (!(confidence >= 0 && confidence <= 1)) throw new RangeError('confidence is between 0 and 1');
  if (rejected <= 0) return confidence;
  const share = rejected / (rejected + accepted + 10);
  const adjusted = confidence * (1 - 0.5 * share);
  return Math.round(Math.max(0.05, adjusted) * 1000) / 1000;
}

/** Settings from what a form posted. A number outside the allowed range is refused, never clipped. */
export function parseSettings(body) {
  const errors = {};
  const flag = (v) => v === true || v === 'on' || v === '1' || v === 'true';
  const raw = String(body?.weeklyDrafts ?? '').trim();
  let weeklyDrafts = AUTOPILOT.defaultWeeklyDrafts;
  if (raw !== '') {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > AUTOPILOT.maxWeeklyDrafts) {
      errors.weeklyDrafts = `Choose a whole number from 0 to ${AUTOPILOT.maxWeeklyDrafts}.`;
    } else {
      weeklyDrafts = n;
    }
  }
  const allowAutoFix = flag(body?.allowAutoFix);
  const allowContent = flag(body?.allowContent);
  return Object.keys(errors).length
    ? { ok: false, errors }
    : {
        ok: true,
        value: { enabled: flag(body?.enabled), allowAutoFix, allowContent, weeklyDrafts },
      };
}

import { AUTOPILOT, KINDS, REJECT_REASONS, SKIP_TEXT, STATUS_LABELS } from './autopilot.js';
import {
  STATUS_LABELS as CONTENT_LABELS,
  STATUS_TONES as CONTENT_TONES,
} from './content-lifecycle.js';

/**
 * What the Autopilot screen says (Milestone 15, UI_DESIGN D9). Pure: stored settings and items go in, the sentences, rows and
 * addresses come out, so every rule is tested without a browser.
 *
 * The rules the screen keeps:
 *   - It says what Autopilot is, in the words of what it does: it prepares, a person approves. It never says "automatically
 *     fixed", "published" or "applied" for something a person has not approved.
 *   - There is no approve button here. An item links to the screen where the exact code or the draft is shown and approved
 *     (the same approval, with the same fingerprint or pinned revision). Only "reject" is done from the list.
 *   - Why it prepared nothing is said in plain words. "Nothing prepared" is never shown as a fault.
 */

const date = (value) =>
  new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });

export const KIND_LABELS = Object.freeze({
  auto_fix: 'Fix for your site',
  content: 'Draft page',
});

const TONES = Object.freeze({
  ready: 'warning',
  approved: 'success',
  rejected: 'neutral',
  withdrawn: 'neutral',
});

/**
 * Where the project stands: on, off, paused, or held back by the plan or a staff switch.
 * @returns {{ state: string, label: string, tone: string, text: string }}
 */
export function standing({ settings, planAllows, flagOn }) {
  if (!flagOn) {
    return {
      state: 'switched_off',
      label: 'Switched off',
      tone: 'neutral',
      text: SKIP_TEXT.switched_off,
    };
  }
  if (!planAllows)
    return { state: 'plan', label: 'Not in your plan', tone: 'neutral', text: SKIP_TEXT.plan };
  if (!settings.enabled)
    return { state: 'off', label: 'Off', tone: 'neutral', text: SKIP_TEXT.off };
  if (settings.pausedAt)
    return { state: 'paused', label: 'Paused', tone: 'warning', text: SKIP_TEXT.paused };
  return {
    state: 'on',
    label: 'On',
    tone: 'success',
    text: 'Autopilot is on. It looks again after every check.',
  };
}

/** What the latest tick did, in a sentence. Null before the first one. */
export function lastTickText(settings) {
  const tick = settings.lastTick;
  if (!settings.lastTickAt || !tick) return null;
  const when = date(settings.lastTickAt);
  if (tick.prepared > 0) {
    return `${when}: prepared ${tick.prepared} ${tick.prepared === 1 ? 'item' : 'items'} for you.`;
  }
  return `${when}: nothing prepared. ${SKIP_TEXT[tick.skipped] ?? SKIP_TEXT.nothing}`;
}

/** How a draft is getting on, for the line under a content item. */
function contentLine(content) {
  if (!content) return { text: 'The draft could not be found.', tone: 'unknown' };
  return {
    text: CONTENT_LABELS[content.status] ?? content.status,
    tone: CONTENT_TONES[content.status] ?? 'neutral',
  };
}

/**
 * @param {object} p
 * @param {object[]} p.ready     `autopilot.inbox()` rows
 * @param {object[]} p.decided   `autopilot.list({ statuses: [approved, rejected, withdrawn] })`
 * @param {Map<string, object>} p.content  content items by their numeric id (as text), for the drafts
 * @param {string} p.projectBase
 */
export function listView({ ready, decided, content = new Map(), projectBase }) {
  const rows = ready.map((item) => {
    const draft = item.kind === 'content' ? content.get(String(item.contentItemId)) : null;
    const line = item.kind === 'content' ? contentLine(draft) : null;
    return {
      id: item.publicId,
      title: item.title,
      kind: item.kind,
      kindLabel: KIND_LABELS[item.kind] ?? item.kind,
      summary: item.summary ?? '',
      preparedOn: date(item.createdAt),
      progress: line,
      // The exact code, or the draft, and the approval, are on those screens: this list approves nothing.
      reviewHref:
        item.kind === 'auto_fix'
          ? `${projectBase}/actions/${item.recommendationId}/autofix`
          : draft
            ? `${projectBase}/content/${draft.publicId}`
            : `${projectBase}/actions/${item.recommendationId}`,
      reviewLabel:
        item.kind === 'auto_fix' ? 'Review the code and approve' : 'Read the draft and approve',
      // A draft still being written cannot be approved yet: the link says where it stands instead.
      waiting: item.kind === 'content' && draft && !['ready', 'failed'].includes(draft.status),
    };
  });
  const earlier = decided.map((item) => ({
    id: item.publicId,
    title: item.title,
    kindLabel: KIND_LABELS[item.kind] ?? item.kind,
    statusLabel: STATUS_LABELS[item.status] ?? item.status,
    tone: TONES[item.status] ?? 'neutral',
    when: date(item.decidedAt ?? item.createdAt),
    detail:
      item.status === 'rejected'
        ? `${REJECT_REASONS[item.rejectReason] ?? 'Rejected'}${item.rejectNote ? `: ${item.rejectNote}` : ''}`
        : item.status === 'withdrawn'
          ? (item.withdrawnReason ?? '')
          : 'You approved it.',
  }));
  return { ready: rows, earlier };
}

/** What the settings form starts from, and the plain-words limits next to it. */
export function settingsView(settings) {
  return {
    enabled: settings.enabled,
    allowAutoFix: settings.allowAutoFix,
    allowContent: settings.allowContent,
    weeklyDrafts: settings.weeklyDrafts,
    paused: Boolean(settings.pausedAt),
    pausedOn: settings.pausedAt ? date(settings.pausedAt) : null,
    limits: [
      `At most ${AUTOPILOT.maxFixesPerWeek} fixes for your site a week.`,
      `At most ${settings.weeklyDrafts} draft${settings.weeklyDrafts === 1 ? '' : 's'} a week, from your monthly draft allowance.`,
      `At most ${AUTOPILOT.maxReady} items waiting for you at once, and ${AUTOPILOT.maxPerDay} prepared in a day.`,
      `An item nobody opens for ${AUTOPILOT.readyExpiresDays / 7} weeks is withdrawn.`,
    ],
    kinds: KINDS,
  };
}

/** The notice the weekly digest carries: how many items are waiting. Null when none (a digest never says "0 ready"). */
export function digestLine(readyCount, { projectBase }) {
  if (!(readyCount > 0)) return null;
  return {
    text: `${readyCount} ${readyCount === 1 ? 'change is' : 'changes are'} ready for your approval.`,
    href: `${projectBase}/autopilot`,
  };
}

/**
 * The life of a Content Studio item (MVP F8): one table of the moves that are allowed and who makes them, like
 * `recommendation-lifecycle.js`. The rule that matters most is that **nothing is published without a person's
 * approval**: `approved` is only ever entered by a person, and every edit after it takes the approval away.
 *
 *   researching → briefing → drafting → qc → ready      the system, one stage after the other (each step is saved and
 *                                                        can be edited before the next one is regenerated)
 *   ready → approved                                     a person, if nothing blocks it (`approvalBlockers`)
 *   approved → publishing → published | failed           a person starts it, the system finishes it
 *   publishing → approved                                the post was saved as a WordPress draft: approved, not live
 *   ready | approved → qc                                a person edited the text: it is scored again
 *   approved → ready                                     a person edited the text, or took the approval back
 *   ready | failed | published → drafting                a person asks for a new draft (a new revision, never an overwrite)
 *   failed → researching | drafting | approved           a person tries again: from the stage that broke, or (a failed
 *                                                        publish) back to approved, whose approval is still in place
 *   anything but archived → archived                     a person puts it away
 */

export const STATUSES = Object.freeze([
  'researching',
  'briefing',
  'drafting',
  'qc',
  'ready',
  'approved',
  'publishing',
  'published',
  'failed',
  'archived',
]);

/** from → { to: who may make the move } */
const MOVES = {
  researching: { briefing: 'system', failed: 'system', archived: 'user' },
  briefing: { drafting: 'system', failed: 'system', archived: 'user' },
  drafting: { qc: 'system', failed: 'system', archived: 'user' },
  qc: { ready: 'system', failed: 'system', archived: 'user' },
  ready: { approved: 'user', qc: 'user', drafting: 'user', archived: 'user' },
  approved: { publishing: 'user', ready: 'user', qc: 'user', archived: 'user' },
  publishing: { published: 'system', approved: 'system', failed: 'system' },
  published: { drafting: 'user', archived: 'user' },
  failed: { researching: 'user', drafting: 'user', approved: 'user', archived: 'user' },
  archived: {},
};

export function canMove(from, to, actor) {
  const who = MOVES[from]?.[to];
  return who !== undefined && who === actor;
}

export const movesFrom = (from, actor) =>
  Object.entries(MOVES[from] ?? {})
    .filter(([, who]) => who === actor)
    .map(([to]) => to);

/** A person can still change the text only while the item is in one of these. */
export const EDITABLE = Object.freeze(['ready', 'approved']);
/** The pipeline is running and the item is waiting for the system. */
export const RUNNING = Object.freeze(['researching', 'briefing', 'drafting', 'qc', 'publishing']);
/** Counts as "in the middle of something": not offered a second pipeline. */
export const OPEN = Object.freeze([
  'researching',
  'briefing',
  'drafting',
  'qc',
  'ready',
  'approved',
  'publishing',
]);

export const STATUS_LABELS = Object.freeze({
  researching: 'Researching',
  briefing: 'Planning',
  drafting: 'Writing',
  qc: 'Checking',
  ready: 'Ready to review',
  approved: 'Approved',
  publishing: 'Publishing',
  published: 'Published',
  failed: 'Needs attention',
  archived: 'Archived',
});

/** The tone of a status badge (`ui.badge`). */
export const STATUS_TONES = Object.freeze({
  researching: 'info',
  briefing: 'info',
  drafting: 'info',
  qc: 'info',
  ready: 'warning',
  approved: 'success',
  publishing: 'info',
  published: 'success',
  failed: 'danger',
  archived: 'neutral',
});

/** What the board groups items under. */
export const BOARD_COLUMNS = Object.freeze([
  {
    key: 'working',
    label: 'Being written',
    statuses: ['researching', 'briefing', 'drafting', 'qc'],
  },
  { key: 'review', label: 'In review', statuses: ['ready', 'approved', 'publishing', 'failed'] },
  { key: 'published', label: 'Published', statuses: ['published'] },
]);

const PIPELINE = [
  { key: 'researching', label: 'Research' },
  { key: 'briefing', label: 'Plan' },
  { key: 'drafting', label: 'Write' },
  { key: 'qc', label: 'Check' },
  { key: 'ready', label: 'Review' },
];

/**
 * The step list on the item screen: each stage done, active, waiting or failed. `failedAt` is the stage that failed
 * (kept in the item's notes), so a failure points at the step that broke.
 */
export function pipelineSteps(status, { failedAt = null } = {}) {
  const at = status === 'failed' ? failedAt : status;
  const reached =
    status === 'approved' || status === 'publishing' || status === 'published' ? 'ready' : at;
  const index = PIPELINE.findIndex((s) => s.key === reached);
  return PIPELINE.map((step, i) => {
    let state = 'todo';
    if (status === 'archived') state = i <= index ? 'done' : 'todo';
    else if (index < 0) state = status === 'failed' ? 'todo' : 'todo';
    else if (i < index) state = 'done';
    else if (i === index) {
      state =
        status === 'failed'
          ? 'failed'
          : step.key === 'ready' || ['approved', 'publishing', 'published'].includes(status)
            ? 'done'
            : 'active';
    }
    return { ...step, state };
  });
}

/**
 * What stops a person approving this draft. A low score does not (a person may judge better than a checklist);
 * a problem that would put something false or broken on the customer's site does.
 *
 * @param {object} input
 * @param {{ blocking: string[], checks: object[] }|null} input.qc  the score of the CURRENT revision
 * @param {number|null} input.qcRevisionId  the revision that score is for
 * @param {number|null} input.currentRevisionId
 * @param {boolean} input.hasJsonld
 */
export function approvalBlockers({ qc, qcRevisionId, currentRevisionId, hasJsonld }) {
  const out = [];
  if (!currentRevisionId) return ['There is no draft to approve yet.'];
  if (!qc) return ['The quality check has not run yet.'];
  if (qcRevisionId !== currentRevisionId)
    out.push('The text changed after the last quality check: check it again first.');
  const labels = {
    unsupported_claims:
      'The text still has a "[needs source]" marker or a quotation that is not in your facts.',
    overlap: 'Most of this text is already on one of your pages.',
    schema_valid: 'The structured data is invalid or says something the page does not.',
  };
  for (const code of qc.blocking ?? [])
    out.push(labels[code] ?? `The check "${code}" found a problem.`);
  if (!hasJsonld) out.push('There is no structured data yet.');
  return out;
}

export function retryStage(failedAt) {
  if (failedAt === 'publishing') return 'approved';
  return failedAt === 'drafting' || failedAt === 'qc' ? 'drafting' : 'researching';
}

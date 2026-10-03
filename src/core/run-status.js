/**
 * What a customer is told about a tracking run (UI_DESIGN: what every state says). Pure: a run row in, words and a
 * tone out, so the page and its tests agree and nothing is decided in a template.
 *
 * A run that could not read some answers says so and says what that means for the numbers: those answers are left
 * out, they are not "not mentioned". A run that read nothing never shows a figure of zero.
 */

export const RUNNING_STATUSES = Object.freeze(['queued', 'collecting', 'extracting', 'rolling_up']);

/**
 * A run that has been "running" this long has lost its job (a Redis that was emptied, say): a run waits 4 hours for its
 * answers and up to 26 for their reading (src/worker/handlers/tracking.js). It is shown as stalled, so a page never
 * says "running" forever and "Run a check now" is not blocked by a run that will never finish.
 */
export const STALE_RUN_MS = 30 * 3_600_000;

/** Is this run really in progress: in a running state, and not stalled? */
export function isRunning(run, now = new Date()) {
  if (!run || !RUNNING_STATUSES.includes(run.status)) return false;
  const since = run.queued_at ? new Date(run.queued_at).getTime() : null;
  return since === null || now.getTime() - since <= STALE_RUN_MS;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * @param run  `{ status, trigger_type, tasks_planned, tasks_ok, tasks_no_answer, tasks_failed, finished_at }` or null
 * @returns `{ state, tone, title, text, running, finishedAt }`; `state` is none, running, stalled, complete, partial,
 *   failed or canceled; `tone` is a banner tone (neutral, info, success, warning, danger).
 */
export function describeRun(run, now = new Date()) {
  if (!run) {
    return {
      state: 'none',
      tone: 'neutral',
      title: 'No check has run yet',
      text: 'Once tracking is on, we ask the AI engines your questions and the results appear here.',
      running: false,
      finishedAt: null,
    };
  }
  const planned = Number(run.tasks_planned) || 0;
  const failed = Number(run.tasks_failed) || 0;
  const finishedAt = run.finished_at ?? null;

  if (RUNNING_STATUSES.includes(run.status) && !isRunning(run, now)) {
    return {
      state: 'stalled',
      tone: 'warning',
      title: 'The last check didn’t finish',
      text: 'We’ve been told. Nothing is shown for it, and you can start another check.',
      running: false,
      finishedAt: null,
    };
  }
  if (RUNNING_STATUSES.includes(run.status)) {
    const first = run.trigger_type === 'onboarding';
    return {
      state: 'running',
      tone: 'info',
      title: first ? 'Your first check is running' : 'A check is running',
      text: 'We’re asking the AI engines your questions. It usually takes a few minutes, and this page refreshes by itself.',
      running: true,
      finishedAt: null,
    };
  }
  if (run.status === 'complete') {
    return {
      state: 'complete',
      tone: 'success',
      title: 'The last check finished',
      text:
        planned === 1
          ? 'The one answer was read.'
          : planned > 1
            ? `All ${planned} answers were read.`
            : 'All answers were read.',
      running: false,
      finishedAt,
    };
  }
  if (run.status === 'partial') {
    return {
      state: 'partial',
      tone: 'warning',
      title: 'The last check is incomplete',
      text: `${failed} of ${plural(planned, 'answer')} couldn’t be checked. They’re left out of your numbers: they are not counted as “not mentioned”.`,
      running: false,
      finishedAt,
    };
  }
  if (run.status === 'failed') {
    return {
      state: 'failed',
      tone: 'danger',
      title: 'The last check couldn’t read any answers',
      text: 'Nothing is shown for it, and no number is guessed. We’ve been told, and the next weekly check tries again.',
      running: false,
      finishedAt,
    };
  }
  return {
    state: 'canceled',
    tone: 'neutral',
    title: 'The last check was canceled',
    text: 'Nothing was recorded for it.',
    running: false,
    finishedAt,
  };
}

/** "3 of 4 extra checks used this month". */
export function runNowLabel({ used, limit }) {
  const left = Math.max(0, limit - used);
  return `${plural(left, 'extra check')} left this month`;
}

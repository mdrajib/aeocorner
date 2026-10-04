/**
 * The life of a recommendation (CUSTOMER_JOURNEY §7 change 2, MVP F7): which status may follow which, and who may move
 * it. Pure: the repository asks here before it writes, and the unit test pins every cell.
 *
 *   open ─→ in_progress ─→ done ─→ verified ──→ measuring ─→ proven_win | no_change | declined
 *     │          │            └──→ unverified ─┬─→ measuring (the customer confirms it is done)
 *     │          │                             └─→ in_progress (fix it again)
 *     └──────────┴─→ dismissed
 *   done, verified, unverified, measuring ─→ in_progress  (system only: the fix was removed from the site, see autofix undo)
 *
 * Who moves it:
 *   user    starts it, marks it done, dismisses it, confirms an unverified fix, or says "fix again"
 *   system  verifies it (the same-day re-check), starts measuring, and records the verdict
 * A person never decides `verified` or a verdict: those come from looking at the site and from the numbers.
 *
 * `proven_win`, `no_change`, `declined` and `dismissed` are final. They free the recommendation's key
 * (`recommendations.open_key` becomes NULL), so the rule engine can raise the same issue again when it still holds,
 * after the waiting time below; a declined one is raised again at once, as the follow-up of the one that declined.
 */

export const STATUSES = Object.freeze([
  'open',
  'in_progress',
  'done',
  'verified',
  'unverified',
  'measuring',
  'proven_win',
  'no_change',
  'declined',
  'dismissed',
]);

export const FINAL_STATUSES = Object.freeze(['proven_win', 'no_change', 'declined', 'dismissed']);
/** What is still "live" for the rule engine: one row per issue (the unique key). */
export const LIVE_STATUSES = Object.freeze(STATUSES.filter((s) => !FINAL_STATUSES.includes(s)));
/** The statuses the customer can still change the scope of: after `done` the scope is frozen for the measurement. */
export const EDITABLE_STATUSES = Object.freeze(['open', 'in_progress']);

export const ACTORS = Object.freeze(['user', 'staff', 'system']);

const TRANSITIONS = Object.freeze({
  open: { in_progress: ['user'], done: ['user'], dismissed: ['user', 'staff'] },
  in_progress: { open: ['user'], done: ['user'], dismissed: ['user', 'staff'] },
  // `in_progress` by the system is the one way back from a fix that was removed from the site (an auto-fix undone): a
  // person asks for the undo, the job removes the code, and only then does the recommendation step back. No person's
  // own move can reset a fix that is being checked or measured.
  done: { verified: ['system'], unverified: ['system'], in_progress: ['system'] },
  verified: { measuring: ['system'], in_progress: ['system'] },
  // The system moves a fix we cannot check by machine straight on: marking it done was the customer's confirmation.
  unverified: { in_progress: ['user', 'system'], measuring: ['user', 'system'] },
  measuring: {
    proven_win: ['system'],
    no_change: ['system'],
    declined: ['system'],
    in_progress: ['system'],
  },
  proven_win: {},
  no_change: {},
  declined: {},
  dismissed: {},
});

export const DISMISS_REASONS = Object.freeze({
  not_relevant: 'Not relevant to us',
  already_done: 'We already did this',
  wont_do: 'We won’t do this',
  incorrect: 'This is wrong',
});

export const STATUS_LABELS = Object.freeze({
  open: 'To do',
  in_progress: 'In progress',
  done: 'Checking',
  verified: 'Verified',
  unverified: 'Done, not verified',
  measuring: 'Measuring',
  proven_win: 'Proven win',
  no_change: 'No change yet',
  declined: 'Declined',
  dismissed: 'Dismissed',
});

export const isStatus = (value) => STATUSES.includes(value);
export const isFinal = (status) => FINAL_STATUSES.includes(status);

/** May an actor of this type move a recommendation from one status to another? Unknown names are always "no". */
export function canTransition(from, to, actor) {
  return TRANSITIONS[from]?.[to]?.includes(actor) ?? false;
}

/** The statuses an actor may move a recommendation to from here. */
export function allowedNext(from, actor) {
  return Object.entries(TRANSITIONS[from] ?? {})
    .filter(([, actors]) => actors.includes(actor))
    .map(([to]) => to);
}

/**
 * The timeline on the detail screen: Open → In progress → Done → Verified → Measuring → Proven win, and what each step
 * is now. A step the recommendation skipped (it went from open straight to done) is `skipped`, not `done`: the screen
 * must not claim the customer "started" something they did not. The last step takes the name of the real end:
 * "Proven win", "No change yet" or "Declined".
 *
 * @returns `[{ key, label, state }]`, state one of `done`, `current`, `upcoming`, `skipped`; nothing for a dismissed one
 */
export function timelineFor(status, { reached = [] } = {}) {
  if (status === 'dismissed' || !isStatus(status)) return [];
  const end = FINAL_STATUSES.includes(status) ? status : 'proven_win';
  const steps = [
    { key: 'open', label: 'To do' },
    { key: 'in_progress', label: 'In progress' },
    { key: 'done', label: 'Done' },
    { key: 'verified', label: 'Verified' },
    { key: 'measuring', label: 'Measuring' },
    { key: end, label: STATUS_LABELS[end] },
  ];
  // `unverified` is the "verified" step that did not pass.
  const position = {
    open: 0,
    in_progress: 1,
    done: 2,
    verified: 3,
    unverified: 3,
    measuring: 4,
    proven_win: 5,
    no_change: 5,
    declined: 5,
  }[status];
  const seen = new Set([...reached, status]);
  return steps.map((step, index) => {
    let state;
    if (index < position) state = seen.has(step.key) || step.key === 'open' ? 'done' : 'skipped';
    else if (index === position) state = FINAL_STATUSES.includes(status) ? 'done' : 'current';
    else state = 'upcoming';
    const label = status === 'unverified' && step.key === 'verified' ? 'Not verified' : step.label;
    return { key: step.key, label, state };
  });
}

// --- Raising an issue again -----------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/** How long a finished or dismissed recommendation keeps the same issue from coming back, by how it ended. */
export const QUIET_DAYS = Object.freeze({
  dismissed: { already_done: 30, default: 90 },
  no_change: 28,
  proven_win: 28,
});

/**
 * The rule engine finds an issue that has no live recommendation. Is it raised again, and as whose follow-up?
 *
 * @param previous  the newest final recommendation with this key, `{ id, status, statusChangedAt, dismissReason }`, or
 *                  null when there is none
 * @returns `{ allowed, parentId }`: a declined one is raised again at once with the old one as its parent; a dismissed,
 *          unchanged or won one stays quiet for a while, so a "won't do" does not come back tomorrow
 */
export function mayRaiseAgain(previous, now) {
  if (!previous) return { allowed: true, parentId: null };
  if (previous.status === 'declined') return { allowed: true, parentId: previous.id };
  const rule = QUIET_DAYS[previous.status];
  if (!rule) return { allowed: true, parentId: null };
  const days = typeof rule === 'number' ? rule : (rule[previous.dismissReason] ?? rule.default);
  const quietUntil = new Date(previous.statusChangedAt).getTime() + days * DAY_MS;
  return { allowed: now.getTime() >= quietUntil, parentId: null };
}

// --- The same-day re-check ------------------------------------------------------------------------------------

/**
 * How a fix is checked. A readiness issue is checked by running the site scan again and reading that check; everything
 * else (a new page, a profile on another site, a tone problem) has no check a machine can make yet, so it is
 * "not verifiable" and goes straight to measuring. (A published page gets a live-URL check in Milestone 7.)
 */
export const verifyMethodFor = (ruleCode) =>
  String(ruleCode).startsWith('readiness.') ? 'readiness_check' : null;

/** The rubric check a readiness rule is about (`readiness.C1` is `C1`), or null for any other rule. */
export const checkCodeOf = (ruleCode) =>
  String(ruleCode).startsWith('readiness.') ? String(ruleCode).slice('readiness.'.length) : null;

/** When the re-checks run after a fix is marked done: at once, then after an hour, then after a day (CDNs cache). */
export const VERIFY_DELAYS_MS = Object.freeze([0, 60 * 60_000, 24 * 60 * 60_000]);
export const MAX_VERIFY_ATTEMPTS = VERIFY_DELAYS_MS.length;

/** The three attempts' times, from the moment the fix was marked done. */
export const verificationSchedule = (doneAt) =>
  VERIFY_DELAYS_MS.map((delay) => new Date(new Date(doneAt).getTime() + delay));

/**
 * What the attempts so far say.
 *
 * @param attempts  `[{ attempt, status }]`, status `passed`, `failed`, `not_verifiable` or `pending`; `couldntCheck`
 *                  marks a failed attempt that was really "we could not look" (the check errored)
 * @returns `{ verdict, reason }`: `verified` once any attempt passed; `unverified` when it can't be checked at all or
 *          every attempt is used; otherwise `continue` (look again at the next time)
 */
export function decideVerification(attempts) {
  const finished = attempts.filter((a) => a.status !== 'pending');
  if (finished.some((a) => a.status === 'passed')) return { verdict: 'verified', reason: 'passed' };
  if (finished.some((a) => a.status === 'not_verifiable')) {
    return { verdict: 'unverified', reason: 'not_verifiable' };
  }
  if (finished.length >= MAX_VERIFY_ATTEMPTS) {
    const last = finished.reduce((a, b) => (b.attempt > a.attempt ? b : a));
    return { verdict: 'unverified', reason: last.couldntCheck ? 'couldnt_check' : 'still_failing' };
  }
  return { verdict: 'continue', reason: null };
}

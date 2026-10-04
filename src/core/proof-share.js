import { proofCards } from './action-center.js';
import { longDate } from './outcomes.js';

/**
 * Sharing a proof card (UI_DESIGN D4). A customer can turn one result into a public, read-only page for a boss or a client.
 * Pure rules: what may be shared, and what the public page says. The page is built only from the outcome, the
 * recommendation's title and the brand's name: no question, answer, competitor or other figure is ever passed in.
 */

/** What the person sees before they share, and what the public page shows. One list, so the two cannot drift apart. */
export const SHARED_FIELDS = Object.freeze([
  'the brand name and its website address',
  'the recommendation’s title',
  'how often the engines named the brand before and after, and the result of the test',
]);

/** Never on a shared page. */
export const NEVER_SHARED = Object.freeze([
  'your questions',
  'the engines’ answers',
  'your competitors',
  'anything else in your account',
]);

/** Only a result that passed the significance test is a win, so only a win is offered for sharing. */
export const canShare = (outcome) =>
  Boolean(outcome) && outcome.verdict === 'proven_win' && outcome.engineScope === 'all';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * The sentence for the public page. The owner's own card says "Since you marked…"; a reader outside the company is not
 * "you", so this says who did what. The figures are the outcome's, nothing more.
 */
export function shareSentence(outcome, { title, startedAt, brandName }) {
  const scope = `on the ${plural(outcome.promptsCount, 'question', 'questions')} it targets`;
  return `Since ${brandName} marked “${title}” done on ${longDate(startedAt)}, ${brandName} was named ${scope} from ${outcome.kBefore} of ${outcome.nBefore} to ${outcome.kAfter} of ${outcome.nAfter} answers. That is bigger than normal variation.`;
}

/**
 * The public page's content, or null when this outcome may not be shared (or has no start date). `startedAt` is when measuring began.
 *
 * @param outcome  an outcome as the repository returns it
 * @param context  `{ title, startedAt, brandName, domain }`
 */
export function publicProof(outcome, { title, startedAt, brandName, domain }) {
  // No start date means we cannot say since when; a page must never show the epoch as a date.
  if (!canShare(outcome) || !startedAt) return null;
  const [card] = proofCards(
    {
      recommendation: { title, measuringStartedAt: startedAt, doneAt: startedAt },
      outcomes: [outcome],
    },
    { brandName },
  );
  return {
    brandName,
    domain: domain ?? '',
    title,
    horizon: card.horizon,
    label: card.label,
    tone: card.tone,
    sentence: shareSentence(outcome, { title, startedAt, brandName }),
    rows: card.rows,
    sure: card.sure,
    computedOn: card.computedOn,
  };
}

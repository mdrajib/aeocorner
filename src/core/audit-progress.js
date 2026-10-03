/**
 * What the visitor sees while an audit runs, and on the report (UI_DESIGN A8, A9). Pure: the route reads the audit's
 * rows and this turns them into steps and cards, so the rules about "couldn't check" live in one tested place.
 *
 * A step is one of `done`, `active`, `waiting` or `unknown`. `unknown` means we tried and could not check it: never
 * shown as a failure of the visitor's site and never as zero.
 */

export const AUDIT_ENGINE_LABELS = Object.freeze({
  chatgpt: 'ChatGPT',
  perplexity: 'Perplexity',
  gemini: 'Gemini',
  google_aio: 'Google AI Overviews',
});

export const AUDIT_ENGINE_ORDER = Object.freeze(Object.keys(AUDIT_ENGINE_LABELS));

const FINAL = new Set(['complete', 'partial', 'failed']);

export const isFinalStatus = (status) => FINAL.has(status);

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The state of one engine's column of answers: `done` when every question has an answer or an honest "no answer",
 * `unknown` when it is finished but some or all could not be read, `active` while some are in, `waiting` before.
 */
export function engineState(rows, questionCount) {
  const mine = rows.filter((r) => r.status !== 'pending');
  const failed = mine.filter((r) => r.status === 'failed').length;
  const good = mine.length - failed;
  if (mine.length < questionCount) {
    return {
      state: rows.length > 0 ? 'active' : 'waiting',
      answered: good,
      failed,
      asked: mine.length,
    };
  }
  return { state: failed > 0 ? 'unknown' : 'done', answered: good, failed, asked: mine.length };
}

/**
 * @param {object} input
 * @param {{ status: string, prompts?: Array }} input.audit
 * @param {{ status: string, pages_fetched?: number } | null} input.scan
 * @param {Array} input.answers  audit_answers rows
 * @param {number} [input.questionCount]  defaults to the number of generated questions, or 5
 */
export function describeProgress({ audit, scan = null, answers = [], questionCount }) {
  const questions = Array.isArray(audit.prompts) ? audit.prompts : [];
  const total = questionCount ?? (questions.length || 5);
  const finished = isFinalStatus(audit.status);
  const started = audit.status !== 'awaiting_verification' && audit.status !== 'queued';
  const steps = [];

  // 1. The readiness scan.
  const scanDone = scan && ['complete', 'partial'].includes(scan.status);
  if (scanDone) {
    const pages = Number(scan.pages_fetched ?? 0);
    steps.push({
      id: 'site',
      state: 'done',
      label: pages > 0 ? `Read your site (${plural(pages, 'page')})` : 'Read your site',
    });
  } else if (scan?.status === 'failed') {
    steps.push({ id: 'site', state: 'unknown', label: 'We couldn’t read your site this time' });
  } else {
    steps.push({
      id: 'site',
      state: started || scan ? 'active' : 'waiting',
      label: 'Reading your site and checking whether AI crawlers can reach it',
    });
  }

  // 2. The brand profile and the questions.
  const haveQuestions = questions.length > 0;
  steps.push({
    id: 'questions',
    state: haveQuestions ? 'done' : started && scanDone ? 'active' : 'waiting',
    label: haveQuestions
      ? `Wrote ${plural(questions.length, 'buyer question')}`
      : 'Writing the questions your buyers would ask',
  });

  // 3. One step per engine.
  const byEngine = new Map();
  for (const row of answers) {
    if (!byEngine.has(row.engine_code)) byEngine.set(row.engine_code, []);
    byEngine.get(row.engine_code).push(row);
  }
  const engines = [...new Set([...AUDIT_ENGINE_ORDER, ...byEngine.keys()])];
  for (const code of engines) {
    const label = AUDIT_ENGINE_LABELS[code] ?? code;
    const s = engineState(byEngine.get(code) ?? [], total);
    // A finished audit with nothing from this engine is "couldn't check", not "still waiting".
    const state =
      finished && (s.state === 'waiting' || s.state === 'active')
        ? s.asked - s.failed > 0
          ? 'done'
          : 'unknown'
        : s.state;
    steps.push({
      id: `engine-${code}`,
      state,
      engine: code,
      label:
        state === 'done'
          ? `Asked ${label}`
          : state === 'unknown'
            ? `We couldn’t check ${label} right now`
            : state === 'active'
              ? `Asking ${label} (${s.asked} of ${total})`
              : `Waiting to ask ${label}`,
    });
  }

  // 4. The score.
  steps.push({
    id: 'score',
    state: audit.status === 'failed' ? 'unknown' : finished ? 'done' : 'waiting',
    label: finished ? 'Worked out your score and fixes' : 'Working out your score and fixes',
  });

  return { steps, done: finished, failed: audit.status === 'failed' };
}

/**
 * The answers to show, one card each: the engine, the question and the real excerpt. Only a readable answer has a
 * card; a failed one is a step that says "couldn't check", not an empty card. `names` are highlighted: the brand
 * first, then whoever the engine named.
 */
export function answerCards({ answers, questions = [], brandName = null, limit = null }) {
  const text = new Map(questions.map((q) => [q.promptIdx, q.text]));
  const order = (code) => {
    const i = AUDIT_ENGINE_ORDER.indexOf(code);
    return i === -1 ? AUDIT_ENGINE_ORDER.length : i;
  };
  const cards = answers
    .filter((a) => a.status === 'ok' && a.text_excerpt)
    .map((a) => {
      const named = (Array.isArray(a.entities) ? a.entities : [])
        .filter((e) => e && typeof e.name === 'string' && e.name.trim())
        .map((e) => ({ term: e.name, kind: e.kind === 'brand' ? 'brand' : 'competitor' }));
      const highlights = brandName ? [{ term: brandName, kind: 'brand' }, ...named] : named;
      return {
        promptIdx: a.prompt_idx,
        engine: a.engine_code,
        engineLabel: AUDIT_ENGINE_LABELS[a.engine_code] ?? a.engine_code,
        question: text.get(a.prompt_idx) ?? `Question ${a.prompt_idx + 1}`,
        text: a.text_excerpt,
        highlights,
      };
    })
    .sort((a, b) => a.promptIdx - b.promptIdx || order(a.engine) - order(b.engine));
  return limit ? cards.slice(-limit) : cards;
}

/** What each engine's card says on the report: its result cell and who it named instead. */
export function engineCards({ answers, questionCount = 5 }) {
  const by = new Map();
  for (const row of answers) {
    if (!by.has(row.engine_code)) by.set(row.engine_code, []);
    by.get(row.engine_code).push(row);
  }
  return [...new Set([...AUDIT_ENGINE_ORDER, ...by.keys()])].map((code) => {
    const rows = by.get(code) ?? [];
    const readable = rows.filter((r) => r.status === 'ok');
    const noAnswer = rows.filter((r) => r.status === 'no_answer').length;
    const mentioned = readable.filter((r) => r.brand_present === true).length;
    // Present is a known yes; absent is only a known no when Claude read it (brand_present === false).
    const known = readable.filter((r) => r.brand_present !== null && r.brand_present !== undefined);
    const rivals = new Map();
    for (const r of readable) {
      for (const e of Array.isArray(r.entities) ? r.entities : []) {
        if (e?.kind === 'brand' || typeof e?.name !== 'string') continue;
        rivals.set(e.name, (rivals.get(e.name) ?? 0) + 1);
      }
    }
    const named = [...rivals.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([name]) => name);

    let status;
    let mentionedFlag;
    if (rows.length > 0 && noAnswer === rows.length) status = 'no_overview';
    else if (known.length === 0) status = 'unknown';
    else {
      status = 'ok';
      mentionedFlag = mentioned > 0;
    }
    return {
      code,
      label: AUDIT_ENGINE_LABELS[code] ?? code,
      status,
      mentioned: mentionedFlag,
      mentionedIn: mentioned,
      readable: known.length,
      asked: questionCount,
      named,
    };
  });
}

/**
 * The one sentence a report opens with (UI_DESIGN A9). It only says what was measured: with no readable answers it
 * says so instead of "0 of 5".
 */
export function headline({ cards, brandName }) {
  const readable = cards.filter((c) => c.status === 'ok');
  if (readable.length === 0) {
    return 'We couldn’t read enough AI answers to say how often you are mentioned.';
  }
  const best = [...readable].sort((a, b) => b.mentionedIn - a.mentionedIn)[0];
  const who = brandName || 'your brand';
  const rival = cards.flatMap((c) => c.named)[0];
  if (best.mentionedIn === 0) {
    return rival
      ? `No engine we could read named ${who}. ${rival} was named instead.`
      : `No engine we could read named ${who} in the questions buyers ask.`;
  }
  return `${best.label} named ${who} in ${best.mentionedIn} of ${best.readable} buyer questions.${
    rival && best.mentionedIn < best.readable ? ` ${rival} was named too.` : ''
  }`;
}

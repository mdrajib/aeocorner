/**
 * Free audits in every state, for the route tests and the browser tests: made through the repositories, not the form,
 * so a test can have a running audit with some answers, a finished one, or one that failed, in one line.
 * Everything is removed with the fixtures (`fx.cleanup()`).
 */
export function auditFixtures({ db, fx }) {
  /** An audit in a given state, without going through the form. */
  async function seedAudit(state = 'queued') {
    const audit = await fx.audit();
    if (state === 'awaiting_verification') return audit;
    await db.audits.verify(audit.id, { leadId: audit.lead_id });
    if (state === 'queued') return db.audits.get(audit.id);
    await db.audits.start(audit.id);
    return db.audits.get(audit.id);
  }

  const QUESTIONS = [0, 1, 2, 3, 4].map((promptIdx) => ({
    promptIdx,
    intent: 'discovery',
    text: `What is the best widget supplier, question ${promptIdx}?`,
    searchQuery: 'best widget supplier',
  }));

  async function answer(audit, promptIdx, engineCode, extra = {}) {
    await db.audits.saveAnswer(audit.id, {
      promptIdx,
      engineCode,
      providerCode: 'dataforseo',
      method: 'api_grounded',
      status: 'ok',
      textExcerpt: `Top picks are Bright Widgets and Acme Widgets for question ${promptIdx}.`,
      brandPresent: true,
      entities: [
        { name: 'Acme Widgets', kind: 'brand', rank: 2, stance: 'recommended' },
        { name: 'Bright Widgets', kind: 'competitor', rank: 1, stance: 'recommended' },
      ],
      citations: [],
      ...extra,
    });
  }

  async function finishedAudit({ status = 'complete', failEngine = null } = {}) {
    const audit = await seedAudit('running');
    await db.audits.saveSetup(audit.id, {
      brandKitLite: { brand_name: 'Acme Widgets' },
      prompts: QUESTIONS,
      suggestedCompetitors: [],
    });
    for (const engine of ['chatgpt', 'perplexity', 'gemini', 'google_aio']) {
      for (let i = 0; i < 5; i += 1) {
        if (engine === failEngine) {
          await answer(audit, i, engine, {
            status: 'failed',
            textExcerpt: null,
            brandPresent: null,
            entities: null,
          });
        } else {
          await answer(audit, i, engine, { brandPresent: engine === 'chatgpt' ? i < 2 : false });
        }
      }
    }
    await db.audits.finish(audit.id, {
      status,
      readinessScore: 54,
      visibilityScore: 15,
      aeoScore: 38,
      subScores: {},
      topFixes: [
        {
          kind: 'readiness',
          id: 'check-robots-ai-access',
          title: 'Let AI search crawlers read your site',
          how: 'Your robots.txt blocks GPTBot.',
          impact: 9,
          evidence: {
            type: 'check',
            checkCode: 'robots',
            summary: 'GPTBot is blocked',
            points: 0,
            possible: 8,
          },
        },
        {
          kind: 'visibility',
          id: 'competitor-ahead',
          title: 'Compete with Bright Widgets where it is being recommended',
          how: 'Publish comparison pages.',
          impact: 6,
          evidence: { type: 'answers', answers: [{ promptIdx: 1, engineCode: 'gemini' }] },
        },
      ],
    });
    return db.audits.get(audit.id);
  }

  /** A running audit with its questions and one engine's answers, to be finished later with `completeLive`. */
  async function liveAudit() {
    const audit = await seedAudit('running');
    await db.audits.saveSetup(audit.id, {
      brandKitLite: { brand_name: 'Acme Widgets' },
      prompts: QUESTIONS,
      suggestedCompetitors: [],
    });
    for (let i = 0; i < 5; i += 1) await answer(audit, i, 'chatgpt');
    return audit;
  }

  /** Finish what `liveAudit` started: the other engines answer and the scores are saved. */
  async function completeLive(audit) {
    for (const engine of ['perplexity', 'gemini', 'google_aio']) {
      for (let i = 0; i < 5; i += 1) await answer(audit, i, engine, { brandPresent: false });
    }
    await db.audits.finish(audit.id, {
      status: 'complete',
      readinessScore: 54,
      visibilityScore: 15,
      aeoScore: 38,
      subScores: {},
      topFixes: [],
    });
  }

  return { QUESTIONS, seedAudit, answer, finishedAudit, liveAudit, completeLive };
}

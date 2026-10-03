import { brandNames, emptyBrandKit } from '../../core/brand-kit.js';
import { parseQuestionCsv } from '../../core/prompt-csv.js';
import {
  INTENTS,
  INTENT_LABELS,
  MAX_SET,
  checkCoverage,
  namingProblem,
  nearDuplicates,
} from '../../core/prompt-rules.js';
import { DomainError } from '../../db/index.js';
import { questionsJobId, slotOf } from '../../lib/job-ids.js';
import { notFound } from '../middleware/errors.js';
import { idFrom, text, withNotice } from './project-helpers.js';

/**
 * The Prompt Manager screen (B9): a project's buyer questions with filters, the intent-coverage check, add, reword, turn
 * on or off, paste-in CSV import, and "write questions for me". Registered on the project router (see projects.js).
 *
 * Nothing is dropped silently. A refused question comes back with the reason, an import answers every row (added,
 * restored, duplicate, invalid or over the plan), and a question that names the brand when it shouldn't (or the other
 * way round) is flagged, not refused: a customer may know better than the rule.
 */

/** The plan's cap on active questions. Plans arrive with billing (Milestone 8); until then every project gets the largest set. */
export const QUESTION_LIMIT = MAX_SET;

/** How long after asking for a set the page keeps refreshing itself before it says it is taking long. */
const GENERATING_WINDOW_MS = 3 * 60_000;

const STATUS_FILTERS = ['active', 'paused', 'archived'];
const intentOptions = (allLabel) => [
  { value: '', label: allLabel },
  ...INTENTS.map((i) => ({ value: i, label: INTENT_LABELS[i] })),
];

const ERRORS = Object.freeze({
  DUPLICATE: 'You already track this question.',
  PLAN_LIMIT: `Your plan allows ${QUESTION_LIMIT} questions and they’re all in use. Archive one to make room.`,
  INVALID_INTENT: 'Choose what kind of question this is.',
  INVALID_PRIORITY: 'Priority should be 1, 2 or 3.',
  ARCHIVED: 'This question is archived. Restore it first.',
});

const messageFor = (err) => ERRORS[err.code] ?? err.message ?? 'That question can’t be saved.';

export function questionRoutes(router, { jobs, logger, appPage, edit }) {
  const projectNames = async (req) => {
    const current = await req.orgDb.brandKits.current(req.project.id);
    const kit =
      current?.data ?? emptyBrandKit({ name: req.project.name, domain: req.project.domain });
    return brandNames(kit);
  };

  /** A question of this project, active or not (the repository only proves it is the organization's). */
  async function findPrompt(req, rawId) {
    const id = idFrom(rawId);
    if (!id) return null;
    const live = await req.orgDb.prompts.list(req.project.id);
    const archived = await req.orgDb.prompts.list(req.project.id, { status: 'archived' });
    return [...live, ...archived].find((p) => p.id === id) ?? null;
  }

  async function renderQuestions(req, res, extra = {}) {
    const filters = {
      q: text(req.query.q, 100),
      intent: INTENTS.includes(req.query.intent) ? req.query.intent : '',
      status: STATUS_FILTERS.includes(req.query.status) ? req.query.status : '',
      clusterId: idFrom(req.query.topic),
    };
    const [everything, rows, clusters, names] = await Promise.all([
      req.orgDb.prompts.list(req.project.id),
      req.orgDb.prompts.list(req.project.id, {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.intent ? { intent: filters.intent } : {}),
        ...(filters.clusterId ? { clusterId: filters.clusterId } : {}),
        ...(filters.q ? { q: filters.q } : {}),
      }),
      req.orgDb.prompts.clusters(req.project.id),
      projectNames(req),
    ]);
    const active = everything.filter((p) => p.status === 'active');
    const coverage = checkCoverage(active, { hasCity: Boolean(req.project.city) });

    // Flags are worked out among the questions in play, so a duplicate of a paused question is still noticed.
    const flags = new Map();
    for (const p of rows) {
      const warnings = [];
      const others = everything.filter((o) => o.id < p.id && o.status !== 'archived');
      const near = p.status === 'archived' ? [] : nearDuplicates(p.text, others);
      if (near.length) warnings.push(`Looks like a duplicate of “${near[0].text}”.`);
      const naming = p.status === 'archived' ? null : namingProblem(p, names);
      if (naming) warnings.push(naming);
      if (warnings.length) flags.set(p.id, warnings);
    }

    const since = Number(req.query.since);
    const before = Number(req.query.n);
    const recent =
      Number.isFinite(since) && Date.now() - since < GENERATING_WINDOW_MS && since <= Date.now();
    const generating = recent && active.length === before;
    const slow =
      Number.isFinite(since) && !recent && active.length === before && Number.isFinite(before);
    if (generating) res.locals.refreshSeconds = 8;

    return appPage(
      res,
      'project-questions',
      {
        prompts: rows,
        flags,
        coverage,
        activeCount: active.length,
        limit: QUESTION_LIMIT,
        filters,
        clusters,
        intentOptions: intentOptions('All kinds'),
        intentFormOptions: intentOptions('Choose…').slice(1),
        generating,
        slow,
        addValues: {},
        addError: '',
        importReport: null,
        importError: '',
        importText: '',
        canEdit: res.locals.can('strategy.edit'),
        meta: {
          title: `Questions · ${req.project.name} | AEO Corner`,
          description: 'The questions we ask AI engines.',
        },
        ...extra,
      },
      extra.status ? { status: extra.status } : {},
    );
  }

  router.get('/projects/:pid/questions', async (req, res, next) => {
    try {
      await renderQuestions(req, res);
    } catch (err) {
      next(err);
    }
  });

  const back = (res, notice, query = '') =>
    res.redirect(303, withNotice(`${res.locals.projectBase}/questions${query}`, notice));

  router.post('/projects/:pid/questions', edit, async (req, res, next) => {
    try {
      const values = {
        text: text(req.body.text, 1000),
        intent: text(req.body.intent, 32),
        priority: Number(req.body.priority) || 2,
        topic: text(req.body.topic, 128),
      };
      try {
        const { similar } = await req.orgDb.prompts.add(
          req.project.id,
          {
            text: values.text,
            intent: values.intent,
            priority: values.priority,
            clusterName: values.topic,
            source: 'manual',
          },
          { actorUserId: req.user.id, limit: QUESTION_LIMIT },
        );
        return back(res, similar.length ? 'question-added-similar' : 'question-added');
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        return renderQuestions(req, res, {
          addValues: values,
          addError: messageFor(err),
          status: 422,
        });
      }
    } catch (err) {
      return next(err);
    }
  });

  router.get('/projects/:pid/questions/:qid/edit', edit, async (req, res, next) => {
    try {
      const prompt = await findPrompt(req, req.params.qid);
      if (!prompt) return notFound(req, res);
      return appPage(res, 'question-edit', {
        prompt,
        values: {
          text: prompt.text,
          intent: prompt.intent,
          priority: prompt.priority,
          topic: prompt.clusterName ?? '',
        },
        error: '',
        intentOptions: intentOptions('Choose…').slice(1),
        meta: {
          title: `Edit question · ${req.project.name} | AEO Corner`,
          description: 'Edit a question.',
        },
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/projects/:pid/questions/import', edit, async (req, res, next) => {
    try {
      const csv = typeof req.body.csv === 'string' ? req.body.csv : '';
      const read = parseQuestionCsv(csv);
      if (!read.ok) {
        return renderQuestions(req, res, {
          importError: read.error,
          importText: csv.slice(0, 20_000),
          status: 422,
        });
      }
      const results = read.rows.length
        ? await req.orgDb.prompts.importMany(
            req.project.id,
            read.rows.map((r) => ({
              text: r.text,
              intent: r.intent,
              priority: r.priority,
              clusterName: r.clusterName,
            })),
            { actorUserId: req.user.id, limit: QUESTION_LIMIT, source: 'imported' },
          )
        : [];
      // Every line of the paste gets an answer, in order: the ones we couldn't read, and the ones we tried.
      const lines = [
        ...read.problems.map((p) => ({
          line: p.line,
          text: '',
          result: 'invalid',
          error: p.error,
        })),
        ...results.map((r, i) => ({
          line: read.rows[i].line,
          text: read.rows[i].text,
          result: r.result,
          error: r.error ?? '',
        })),
      ].sort((a, b) => a.line - b.line);
      const count = (name) => lines.filter((l) => l.result === name).length;
      return renderQuestions(req, res, {
        importReport: {
          added: count('added'),
          restored: count('restored'),
          duplicate: count('duplicate'),
          invalid: count('invalid'),
          overLimit: count('over_limit'),
          lines,
        },
      });
    } catch (err) {
      return next(err);
    }
  });

  router.post('/projects/:pid/questions/generate', edit, async (req, res, next) => {
    try {
      if (!jobs) return back(res, 'queue-down');
      const active = (await req.orgDb.prompts.list(req.project.id, { status: 'active' })).length;
      if (active >= QUESTION_LIMIT) return back(res, 'question-limit');
      try {
        await jobs.add(
          'questions.generate',
          { orgId: String(req.org.id), projectId: String(req.project.id), count: 30 },
          { jobId: questionsJobId(req.project.id, active, slotOf(new Date())) },
        );
      } catch (err) {
        logger.error(
          { err, projectId: String(req.project.id) },
          'Could not queue the question set',
        );
        return back(res, 'queue-down');
      }
      return back(res, 'questions-queued', `?since=${Date.now()}&n=${active}`);
    } catch (err) {
      return next(err);
    }
  });

  router.post('/projects/:pid/questions/:qid', edit, async (req, res, next) => {
    try {
      const prompt = await findPrompt(req, req.params.qid);
      if (!prompt) return notFound(req, res);
      const values = {
        text: text(req.body.text, 1000),
        intent: text(req.body.intent, 32),
        priority: Number(req.body.priority) || 2,
        topic: text(req.body.topic, 128),
      };
      try {
        await req.orgDb.prompts.edit(
          prompt.id,
          {
            text: values.text,
            intent: values.intent,
            priority: values.priority,
            clusterName: values.topic,
          },
          { actorUserId: req.user.id },
        );
        return back(res, 'question-saved');
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        return appPage(
          res,
          'question-edit',
          {
            prompt,
            values,
            error: messageFor(err),
            intentOptions: intentOptions('Choose…').slice(1),
            meta: {
              title: `Edit question · ${req.project.name} | AEO Corner`,
              description: 'Edit a question.',
            },
          },
          { status: 422 },
        );
      }
    } catch (err) {
      return next(err);
    }
  });

  router.post('/projects/:pid/questions/:qid/status', edit, async (req, res, next) => {
    try {
      const prompt = await findPrompt(req, req.params.qid);
      if (!prompt) return notFound(req, res);
      const status = STATUS_FILTERS.includes(req.body.status) ? req.body.status : null;
      if (!status) return back(res, 'question-invalid');
      try {
        await req.orgDb.prompts.setStatus(prompt.id, status, {
          actorUserId: req.user.id,
          limit: QUESTION_LIMIT,
        });
      } catch (err) {
        if (err instanceof DomainError && err.code === 'PLAN_LIMIT')
          return back(res, 'question-limit');
        throw err;
      }
      return back(res, 'question-status');
    } catch (err) {
      return next(err);
    }
  });
}

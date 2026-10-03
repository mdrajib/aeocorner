import { createHash, createHmac } from 'node:crypto';
import express, { Router } from 'express';
import { z } from 'zod';
import { answerCards, describeProgress, engineCards, headline } from '../../core/audit-progress.js';
import { evaluateAuditBudget, toMicros, utcDayStart } from '../../core/spend.js';
import { reportUrl } from '../../lib/audit-mail.js';
import { scoreBand } from '../../lib/funnel.js';
import { isUlid } from '../../lib/ulid.js';
import { normalizeWebsite } from '../../lib/url.js';
import { homeFaq } from '../content/faq.js';
import { publicPages } from '../pages.js';

const home = publicPages.find((p) => p.view === 'home');

/** The wording the marketing-consent box was shown with (stored with the lead: DATABASE_SCHEMA §2.8). */
export const CONSENT_VERSION = 'audit-tips-2026-10-03';

// Form fields arrive as strings. A repeated field (a=1&a=2) or a nested one (a[]=1) arrives as an
// array/object: that is never one website address, so it is treated as invalid rather than ignored.
const isMalformed = (value) => value !== undefined && typeof value !== 'string';
const field = (value) => (typeof value === 'string' ? value.trim().slice(0, 2048) : '');

const form = express.urlencoded({ extended: false, limit: '10kb' });
const emailSchema = z.string().max(254).pipe(z.email());

/** Check the address and the optional competitor, the same way at every step that carries them. */
function checkSites(body) {
  const values = { url: field(body.url), competitor_url: field(body.competitor_url) };
  const errors = {};
  const site = isMalformed(body.url) ? normalizeWebsite('') : normalizeWebsite(values.url);
  if (!site.ok) errors.url = site.message;

  let competitor = null;
  if (isMalformed(body.competitor_url)) {
    errors.competitor_url = normalizeWebsite('not a website').message;
  } else if (values.competitor_url) {
    const checked = normalizeWebsite(values.competitor_url);
    if (checked.ok) competitor = checked;
    else errors.competitor_url = checked.message;
  }
  return { values, errors, site: site.ok ? site : null, competitor };
}

/** Audit pages are private to one visitor: no PostHog (the address is a secret) and no "run an audit" band. */
const QUIET = { analytics: false, showAuditBand: false };

const meta = (title, description) => ({ title, description, noindex: true, path: '/' });

/** "ma***@acme.com": enough to recognise your own address, not enough to read someone else's. */
export function maskEmail(email) {
  const [local, domain = ''] = String(email).split('@');
  return `${local.slice(0, 2)}${'•'.repeat(Math.max(1, Math.min(local.length - 2, 6)))}@${domain}`;
}

const formatWait = (ms) => {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 90 ? `${minutes} minutes` : `${Math.ceil(minutes / 60)} hours`;
};

/** What the visitor is told when the limiter says no. It never blames them, and "blocked" says nothing about why. */
const REFUSALS = {
  disposable_email: {
    status: 422,
    field: 'email',
    message: 'That looks like a temporary email address. Please use your work or personal email.',
  },
  blocked: {
    status: 403,
    message: 'We can’t run a free audit from this connection right now. Please try again later.',
  },
  email: { status: 429, message: 'You’ve used today’s free audits for this email address.' },
  ip: { status: 429, message: 'This connection has run its free audits for today.' },
  domain: {
    status: 429,
    message: 'This website has already been audited several times today.',
  },
};

const TURNSTILE_MESSAGES = {
  rejected: 'We couldn’t confirm you’re a person. Please try the check again.',
  wrong_site: 'We couldn’t confirm you’re a person. Please reload the page and try again.',
  unavailable: 'The bot check isn’t reachable right now. Please try again in a minute.',
  not_configured: 'The bot check isn’t reachable right now. Please try again in a minute.',
};

/**
 * The free audit before the audit is open (no database, or no Redis, or no mail): it checks what was typed and says
 * the audit isn't open yet. Nothing is stored, queued or fetched. Used by the public-page tests and by a local
 * server started without the services the real flow needs.
 */
export function auditStubRoutes() {
  const router = Router();
  router.get('/audit', (req, res) => res.redirect(302, '/#audit'));
  router.post('/audit', form, (req, res) => {
    const { values, errors, site } = checkSites(req.body ?? {});
    if (Object.keys(errors).length) return renderHomeWithErrors(res, values, errors);
    res.page('audit-soon', {
      analytics: true,
      domain: site.domain,
      meta: meta(
        'The free audit opens soon | AEO Corner',
        'The AEO Corner free audit is not open yet.',
      ),
    });
  });
  return router;
}

function renderHomeWithErrors(res, values, errors) {
  return res.page(
    'home',
    {
      analytics: true,
      faq: homeFaq,
      audit: { values, errors },
      meta: { title: home.title, description: home.description, path: '/', noindex: true },
    },
    { status: 422 },
  );
}

/** Seconds a queued audit waits before the progress page asks for its job again (a lost job must not strand it). */
const REQUEUE_AFTER_MS = 60_000;
const STREAM_EVERY_MS = 2_000;
const STREAM_MAX_MS = 12 * 60_000;
const STREAMS_PER_IP = 4;

/**
 * The free audit (MVP F1, UI_DESIGN A6–A9):
 *   POST /audit                    the address is fine: ask for the work email
 *   POST /audit/email              email + Turnstile + limits, then the code is emailed
 *   GET|POST /audit/:id/verify     the six digits (and POST …/resend for a new code)
 *   GET /audit/:id/progress        the live page; /events is its server-sent stream
 *   GET /r/:id                     the report; /r/:id/track is the "track weekly" button
 *
 * The report address is the audit's `public_id` (a ULID, so unguessable). Nothing here reveals whether an audit
 * exists to someone without its address: an unknown or unverified audit is a plain 404.
 *
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.db        the repositories (src/db): `audits`, `leads`
 * @param {object} deps.audit     { otp, limiter, turnstile, mail, jobs, funnel }: src/lib/{otp,audit-limits,turnstile,
 *                                audit-mail,jobs,funnel}.js
 * @param {object} deps.logger
 */
export function auditRoutes({ config, db, audit: svc, logger, now = () => new Date() }) {
  const router = Router();
  const streams = new Map(); // ip -> open event streams
  const funnel = (event, props) => svc.funnel?.capture(event, props);

  const ipHash = (ip) =>
    createHmac('sha256', config.appSecret)
      .update(`audit-ip\n${ip ?? ''}`)
      .digest();

  const urlOf = (audit, page) => `/audit/${audit.public_id}/${page}`;
  const reportOf = (audit) => `/r/${audit.public_id}`;
  const private_ = (res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex');
  };

  /** The audit a path names, or a plain 404 (also for one whose visitor never proved their email). */
  async function load(req, res, next) {
    const id = req.params.publicId;
    const found = isUlid(id) ? await db.audits.getByPublicId(id) : null;
    if (!found || found.status === 'blocked') return next('route');
    req.audit = found;
    private_(res);
    return next();
  }

  const whereNext = (audit) =>
    audit.status === 'awaiting_verification'
      ? 'verify'
      : ['complete', 'partial', 'failed'].includes(audit.status)
        ? 'report'
        : 'progress';

  // ---- step 1: the address ------------------------------------------------------------------------------

  router.get('/audit', (req, res) => res.redirect(302, '/#audit'));

  router.post('/audit', form, async (req, res) => {
    const { values, errors, site } = checkSites(req.body ?? {});
    if (Object.keys(errors).length) return renderHomeWithErrors(res, values, errors);
    funnel('audit_form_submitted', { has_competitor: Boolean(values.competitor_url) });
    res.page('audit-email', emailPage({ values, domain: site.domain }));
  });

  // ---- step 2: the email --------------------------------------------------------------------------------

  const emailPage = ({ values, domain, errors = {}, banner = null, email = '' }) => ({
    ...QUIET,
    domain,
    values,
    errors,
    banner,
    email,
    turnstile: true,
    meta: meta(
      'Where should we send your report? | AEO Corner',
      'Confirm your email to start the free AEO audit.',
    ),
  });

  router.post('/audit/email', form, async (req, res) => {
    const body = req.body ?? {};
    const { values, errors, site, competitor } = checkSites(body);
    if (Object.keys(errors).length) return renderHomeWithErrors(res, values, errors);
    const again = (status, extra) =>
      res.page(
        'audit-email',
        emailPage({ values, domain: site.domain, email: field(body.email), ...extra }),
        {
          status,
        },
      );

    const parsed = emailSchema.safeParse(typeof body.email === 'string' ? body.email.trim() : '');
    if (!parsed.success) {
      return again(422, {
        errors: { email: 'Enter your email address, like you@yourcompany.com.' },
      });
    }
    const email = parsed.data.toLowerCase();

    const token = body['cf-turnstile-response'];
    const human = await svc.turnstile.verify({ token, remoteIp: req.ip });
    if (!human.ok) {
      if (human.reason === 'not_configured')
        logger.error('Turnstile has no secret key: audits are closed');
      return again(
        human.reason === 'unavailable' || human.reason === 'not_configured' ? 503 : 422,
        {
          banner: {
            tone: 'danger',
            text: TURNSTILE_MESSAGES[human.reason] ?? TURNSTILE_MESSAGES.rejected,
          },
        },
      );
    }

    const verdict = await svc.limiter.admit({ ip: req.ip, email, domain: site.domain });
    if (!verdict.allowed) {
      const refusal = REFUSALS[verdict.reason] ?? REFUSALS.blocked;
      if (refusal.field)
        return again(refusal.status, { errors: { [refusal.field]: refusal.message } });
      const when = verdict.retryAfterMs
        ? ` You can try again in about ${formatWait(verdict.retryAfterMs)}.`
        : '';
      return again(refusal.status, {
        banner: { tone: 'warning', text: `${refusal.message}${when}` },
      });
    }

    const hash = ipHash(req.ip);
    const lead = await db.leads.capture({
      email,
      consent: body.consent === '1',
      consentVersion: CONSENT_VERSION,
      ipHash: hash,
      now: now(),
    });
    const created = await db.audits.create({
      inputUrl: values.url,
      domain: site.domain,
      competitorDomain: competitor?.domain ?? null,
      leadId: lead.id,
      ipHash: hash,
    });

    const sent = await sendCode({ audit: created, email });
    if (!sent.ok) {
      return again(sent.status, { banner: { tone: 'danger', text: sent.message } });
    }
    funnel('audit_email_submitted', { consent: body.consent === '1' });
    res.redirect(303, urlOf(created, 'verify'));
  });

  /** Make a code and email it. `ok: false` carries what to tell the visitor. */
  async function sendCode({ audit, email }) {
    const issued = await svc.otp.issue(String(audit.id));
    if (!issued.ok) {
      return {
        ok: false,
        status: 429,
        reason: issued.reason,
        message:
          issued.reason === 'cooldown'
            ? `A code was just sent. You can ask for another in ${formatWait(issued.retryAfterMs)}.`
            : 'We’ve sent the most codes we can for this audit. Please start again in an hour.',
      };
    }
    try {
      await svc.mail.sendVerificationCode({
        to: email,
        code: issued.code,
        auditPublicId: audit.public_id,
      });
    } catch (err) {
      logger.error({ err: err.message }, 'The audit code email was not sent');
      return {
        ok: false,
        status: 502,
        message: 'We couldn’t send the email. Please try again in a minute.',
      };
    }
    return { ok: true };
  }

  // ---- step 3: the code ---------------------------------------------------------------------------------

  async function verifyPage(req, res, { status = 200, errors = {}, banner = null } = {}) {
    const lead = await db.leads.get(req.audit.lead_id);
    res.page(
      'audit-verify',
      {
        ...QUIET,
        publicId: req.audit.public_id,
        domain: req.audit.domain,
        maskedEmail: maskEmail(lead?.email ?? ''),
        errors,
        banner,
        meta: meta(
          'Enter your code | AEO Corner',
          'Enter the 6-digit code we emailed you to start the free AEO audit.',
        ),
      },
      { status },
    );
  }

  router.get('/audit/:publicId/verify', load, async (req, res) => {
    if (req.audit.status !== 'awaiting_verification')
      return res.redirect(302, destination(req.audit));
    const banner =
      req.query.sent === '1'
        ? { tone: 'success', text: 'We sent a new code. The old one no longer works.' }
        : null;
    return verifyPage(req, res, { banner });
  });

  router.post('/audit/:publicId/verify', form, load, async (req, res) => {
    const audit = req.audit;
    if (audit.status !== 'awaiting_verification') return res.redirect(303, destination(audit));

    const result = await svc.otp.verify(String(audit.id), req.body?.code);
    if (!result.ok) {
      const message =
        result.reason === 'malformed'
          ? 'Enter the 6 digits from the email.'
          : result.reason === 'wrong'
            ? `That code isn’t right. You have ${result.attemptsLeft} ${result.attemptsLeft === 1 ? 'try' : 'tries'} left.`
            : result.reason === 'locked'
              ? 'Too many wrong tries, so we cancelled that code. Ask for a new one below.'
              : 'That code has expired. Ask for a new one below.';
      return verifyPage(req, res, { status: 422, errors: { code: message } });
    }

    const lead = await db.leads.markVerified(audit.lead_id);
    const first = await db.audits.verify(audit.id, { leadId: lead?.id });
    await enqueue(audit);
    if (first) funnel('audit_code_verified', {});
    res.redirect(303, urlOf(audit, 'progress'));
  });

  router.post('/audit/:publicId/resend', form, load, async (req, res) => {
    if (req.audit.status !== 'awaiting_verification')
      return res.redirect(303, destination(req.audit));
    const lead = await db.leads.get(req.audit.lead_id);
    const sent = await sendCode({ audit: req.audit, email: lead.email });
    if (!sent.ok) {
      return verifyPage(req, res, {
        status: sent.status,
        banner: { tone: 'warning', text: sent.message },
      });
    }
    return res.redirect(303, `${urlOf(req.audit, 'verify')}?sent=1`);
  });

  const destination = (audit) => {
    const where = whereNext(audit);
    return where === 'report' ? reportOf(audit) : urlOf(audit, where);
  };

  /** One job per audit however often it is asked for (the job ID is the audit). A failure is logged, not shown. */
  async function enqueue(audit) {
    try {
      await svc.jobs.add(
        'audit.run',
        { auditId: String(audit.id) },
        { jobId: `audit-${audit.id}` },
      );
      return true;
    } catch (err) {
      logger.error({ err: err.message, audit: String(audit.id) }, 'The audit job was not queued');
      return false;
    }
  }

  // ---- step 4: progress ---------------------------------------------------------------------------------

  async function snapshot(audit) {
    const fresh = (await db.audits.get(audit.id)) ?? audit;
    const [scan, answers] = await Promise.all([
      db.audits.scans.forAudit(fresh.id),
      db.audits.answers(fresh.id),
    ]);
    const questions = Array.isArray(fresh.prompts) ? fresh.prompts : [];
    const progress = describeProgress({ audit: fresh, scan, answers });
    const cards = answerCards({
      answers,
      questions,
      brandName: fresh.brand_kit_lite?.brand_name ?? null,
      limit: 3,
    });
    return { row: fresh, progress, cards, domain: fresh.domain };
  }

  router.get('/audit/:publicId/progress', load, async (req, res) => {
    const audit = req.audit;
    if (audit.status === 'awaiting_verification') return res.redirect(302, urlOf(audit, 'verify'));
    if (['complete', 'partial', 'failed'].includes(audit.status))
      return res.redirect(302, reportOf(audit));

    // A verified audit whose job never reached the queue would wait here forever: ask for it again. The job ID is
    // the audit, so this is a no-op while the job exists.
    const waited = now().getTime() - new Date(audit.verified_at ?? audit.created_at).getTime();
    if (audit.status === 'queued' && waited > REQUEUE_AFTER_MS) await enqueue(audit);

    // When today's free-audit budget is spent the worker holds a new audit until the next UTC midnight
    // (src/worker/audit-budget.js). Say so, instead of leaving the visitor watching "waiting" for hours.
    let delayedUntil = null;
    if (audit.status === 'queued') {
      const at = now();
      const verdict = evaluateAuditBudget({
        spentMicros: await db.audits.ledger.spentSinceMicros(utcDayStart(at)),
        capMicros: toMicros(config.auditDailyBudgetUsd),
        now: at,
      });
      if (!verdict.open) delayedUntil = verdict.until;
    }

    const data = await snapshot(audit);
    res.page('audit-progress', {
      ...QUIET,
      publicId: audit.public_id,
      delayedHours: delayedUntil
        ? Math.max(1, Math.ceil((delayedUntil.getTime() - now().getTime()) / 3_600_000))
        : null,
      ...data,
      meta: meta(`Checking ${audit.domain} | AEO Corner`, 'Your free AEO audit is running.'),
    });
  });

  router.get('/audit/:publicId/events', load, async (req, res) => {
    const ip = req.ip ?? 'unknown';
    if ((streams.get(ip) ?? 0) >= STREAMS_PER_IP) return res.status(429).end();
    streams.set(ip, (streams.get(ip) ?? 0) + 1);

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // Nginx: do not hold the stream back
    });
    res.flushHeaders();
    res.write('retry: 5000\n\n');

    let closed = false;
    let last = '';
    let timer = null;
    const started = Date.now();
    const finish = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      const left = (streams.get(ip) ?? 1) - 1;
      if (left > 0) streams.set(ip, left);
      else streams.delete(ip);
    };
    req.on('close', finish);

    const tick = async () => {
      if (closed) return;
      try {
        const data = await snapshot(req.audit);
        const html = await renderFeed(req.app, res.locals.ui, data);
        const signature = createHash('sha1').update(html).digest('hex');
        if (data.progress.done) {
          res.write(`event: done\ndata: ${JSON.stringify({ url: reportOf(data.row) })}\n\n`);
          finish();
          return res.end();
        }
        if (signature !== last) {
          last = signature;
          res.write(`event: progress\ndata: ${JSON.stringify({ html })}\n\n`);
        } else {
          res.write(': keep-alive\n\n');
        }
      } catch (err) {
        logger.warn({ err: err.message }, 'Audit progress stream error');
        res.write(': error\n\n');
      }
      if (Date.now() - started > STREAM_MAX_MS) {
        finish();
        return res.end();
      }
      timer = setTimeout(tick, STREAM_EVERY_MS);
    };
    tick();
  });

  // ---- the report ---------------------------------------------------------------------------------------

  router.get('/r/:publicId', load, async (req, res) => {
    const audit = req.audit;
    if (audit.status === 'awaiting_verification') return next404(req, res);
    if (['queued', 'running'].includes(audit.status))
      return res.redirect(302, urlOf(audit, 'progress'));

    if (audit.status === 'failed') {
      funnel('audit_report_viewed', { status: 'failed' });
      return res.page(
        'audit-report',
        {
          ...QUIET,
          failed: true,
          domain: audit.domain,
          meta: meta(
            `${audit.domain}: the audit didn’t finish | AEO Corner`,
            'The free AEO audit could not be completed.',
          ),
        },
        { status: 200 },
      );
    }

    const answers = await db.audits.answers(audit.id);
    const source = audit.cached_from_audit_id
      ? await db.audits.get(audit.cached_from_audit_id)
      : null;
    const questions = Array.isArray(audit.prompts) ? audit.prompts : [];
    const brandName = audit.brand_kit_lite?.brand_name ?? null;
    const cards = engineCards({ answers, questionCount: questions.length || 5 });
    const fixes = Array.isArray(audit.top_fixes) ? audit.top_fixes : [];

    funnel('audit_report_viewed', {
      status: audit.status,
      cached: Boolean(source),
      score_band: scoreBand(audit.aeo_score),
    });
    res.page('audit-report', {
      ...QUIET,
      failed: false,
      publicId: audit.public_id,
      shareUrl: reportUrl(config.baseUrl, audit.public_id),
      row: audit,
      domain: audit.domain,
      brandName,
      headline: headline({ cards, brandName }),
      cards,
      answers: answerCards({ answers, questions, brandName }),
      fixes: fixes.map((fix) => ({ ...fix, evidenceLinks: evidenceLinks(fix, questions) })),
      cachedAt: source?.finished_at ?? null,
      finishedAt: audit.finished_at,
      hoursAgo: source?.finished_at
        ? Math.max(
            0,
            Math.round((now().getTime() - new Date(source.finished_at).getTime()) / 3_600_000),
          )
        : null,
      couldntCheck: cards.filter((c) => c.status === 'unknown').map((c) => c.label),
      meta: meta(
        `AEO report for ${audit.domain} | AEO Corner`,
        `How AI answer engines talk about ${audit.domain}.`,
      ),
    });
  });

  router.get('/r/:publicId/track', load, async (req, res) => {
    funnel('audit_track_clicked', {});
    res.redirect(302, `/app/new-org?domain=${encodeURIComponent(req.audit.domain)}`);
  });

  const next404 = (req, res) => {
    return res.page(
      'not-found',
      {
        meta: meta('Page not found | AEO Corner', 'The page you were looking for does not exist.'),
      },
      { status: 404 },
    );
  };

  return router;
}

/** Where a fix's evidence is on the page: the answers it came from, or the check it came from. */
function evidenceLinks(fix, questions) {
  const evidence = fix.evidence ?? {};
  if (evidence.type !== 'answers') return [];
  const text = new Map(questions.map((q) => [q.promptIdx, q.text]));
  return (evidence.answers ?? []).slice(0, 4).map((a) => ({
    href: `#answer-${a.promptIdx}-${a.engineCode}`,
    label: text.get(a.promptIdx) ?? `Question ${a.promptIdx + 1}`,
  }));
}

function renderFeed(app, ui, data) {
  return new Promise((resolve, reject) => {
    app.render('partials/audit-feed', { ...data, ui }, (err, html) =>
      err ? reject(err) : resolve(html),
    );
  });
}

import express, { Router } from 'express';
import { FindingsError, normalizeFindings } from '../../core/tool-findings.js';
import { toolDefinitions } from '../tools/index.js';
import { hubPageFor, toolPage } from '../tools/registry.js';
import { fieldErrors } from '../tools/shared.js';
import { pageJsonLd } from './public.js';

/**
 * The free tools (Milestone 17, ADR-0017):
 *   GET  /tools           the hub: what each tool does
 *   GET  /tools/:slug     the tool's own page: the answer to the question it is named for, the form, the FAQ (indexed)
 *   POST /tools/:slug     runs the tool and answers with the same page plus the result (quiet: no-store, noindex)
 *   POST /tools/:slug/download   a generator's file as a download: the same run, answered as a text file
 *
 * A tool is a definition (a module in src/web/tools/, listed in its index.js):
 *   slug, kind ('fetch' asks someone's site, 'generate' only runs our code on what was typed), kindFor(input)?
 *   (for a tool with both: the kind of this submission), badge? (the hub card's label)
 *   name, crumb, title, description, lastmod, lead, cannotSee, faq: [{ q, a }]   the page's words
 *   fields: [{ name, label, type, hint, placeholder, rows, options, required, default, checkbox }]   the form
 *   download? true for a generator whose answer is a file: the answer gets a Download button
 *   submitLabel
 *   schema    zod: the form's body -> the input `run` gets (a bad body is a 422 with a message per field)
 *   domain    fetch tools: input -> the site asked, for the per-domain limit
 *   run       async (ctx, input) -> findings (src/core/tool-findings.js; the gate cuts and checks them)
 *
 * The services (`svc`) are { limiter, turnstile, runner }. Without them the pages still render and a run says the tool
 * opens soon: nothing is fetched, counted or stored. A fetch tool also needs Turnstile and refuses to run without it.
 */

// A form post is percent-encoded (every quote in pasted JSON is three characters), so the largest paste a tool takes
// (200,000 characters) needs room for about 600 KB. A body over this is refused (413) before any tool reads it.
const form = express.urlencoded({ extended: false, limit: '1mb' });

/** What the visitor is told when the limiter says no. It never blames them, and "blocked" says nothing about why. */
const REFUSALS = {
  blocked: {
    status: 403,
    text: 'We can’t run this tool from this connection right now. Please try again later.',
  },
  ip_minute: { status: 429, text: 'That’s a lot of checks in a minute. Please wait a moment.' },
  ip_day: { status: 429, text: 'This connection has used today’s free checks.' },
  domain_hour: {
    status: 429,
    text: 'This website has been checked several times in the last hour. Please try again later.',
  },
};

const TURNSTILE_MESSAGES = {
  rejected: 'We couldn’t confirm you’re a person. Please try the check again.',
  wrong_site: 'We couldn’t confirm you’re a person. Please reload the page and try again.',
  unavailable: 'The bot check isn’t reachable right now. Please try again in a minute.',
  not_configured: 'The bot check isn’t reachable right now. Please try again in a minute.',
};

const formatWait = (ms) => {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 90 ? `${minutes} minutes` : `${Math.ceil(minutes / 60)} hours`;
};

/** The form as it was typed, for showing again. A value that is not a string (a repeated field) is dropped. */
function valuesOf(def, body = {}) {
  const out = {};
  for (const f of def.fields) {
    out[f.name] =
      f.type === 'checkbox'
        ? body[f.name] !== undefined
        : typeof body[f.name] === 'string'
          ? body[f.name]
          : '';
  }
  return out;
}

const defaultsOf = (def) =>
  Object.fromEntries(
    def.fields.map((f) => [f.name, f.type === 'checkbox' ? Boolean(f.default) : (f.default ?? '')]),
  );

export function toolRoutes({
  config,
  db = null,
  tools: svc = null,
  logger = null,
  funnel = null,
}) {
  const router = Router();
  const definitions = svc?.definitions ?? toolDefinitions;
  if (!definitions.length) return router;
  const bySlug = new Map(definitions.map((d) => [d.slug, d]));
  const hubPage = hubPageFor(definitions);

  const quiet = (res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex');
  };

  /** The tool's page. A POST answer (`answer: true`) is private to the visitor: no cache, no index, no analytics. */
  function render(
    res,
    def,
    { values, errors = {}, banner = null, result = null, status = 200, answer = false },
  ) {
    const page = toolPage(def);
    if (answer) quiet(res);
    res.page(
      'tool',
      {
        analytics: !answer,
        turnstile: def.kind === 'fetch' && Boolean(svc?.turnstile),
        tool: def,
        values: values ?? defaultsOf(def),
        errors,
        banner,
        result,
        faq: def.faq,
        meta: {
          title: page.title,
          description: page.description,
          path: page.path,
          noindex: answer,
          jsonLd: answer ? [] : pageJsonLd(page, config, { faq: def.faq }),
        },
      },
      { status },
    );
  }

  router.get('/tools', (req, res) => {
    res.page('tools-hub', {
      analytics: true,
      tools: definitions.map((d) => ({
        slug: d.slug,
        name: d.name,
        lead: d.lead,
        badge: d.badge ?? (d.kind === 'fetch' ? 'Checks a website' : 'Builds a file'),
      })),
      meta: {
        title: hubPage.title,
        description: hubPage.description,
        path: hubPage.path,
        jsonLd: pageJsonLd(hubPage, config),
      },
    });
  });

  router.get('/tools/:slug', (req, res, next) => {
    const def = bySlug.get(req.params.slug);
    if (!def) return next('route');
    return render(res, def, {});
  });

  /**
   * One run. With `download` (the file button on a generator's answer) a good result is sent as a file, with the same
   * checks and the same limits as the page: it is a run like any other. Anything else is the page, with its message.
   */
  const handle = (download) => async (req, res, next) => {
    try {
      const def = bySlug.get(req.params.slug);
      if (!def || (download && !def.download)) return next('route');
      const values = valuesOf(def, req.body);
      const refuse = (status, text, extra = {}) =>
        render(res, def, {
          values,
          status,
          answer: true,
          banner: { tone: 'danger', text },
          ...extra,
        });

      // Closed: no services behind it (a local server), or switched off by staff.
      const soon = () =>
        render(res, def, {
          values,
          status: 503,
          answer: true,
          banner: {
            tone: 'info',
            text: 'This tool opens soon. Nothing you entered was checked or saved.',
          },
        });
      if (!svc?.limiter || !svc?.runner) return soon();
      if (db) {
        let open = false;
        try {
          open = await db.system.flags.isEnabled('free_tools');
        } catch (err) {
          logger?.error(
            { err: err.message },
            'The free_tools flag could not be read: tools are closed',
          );
        }
        if (!open)
          return refuse(
            503,
            'The free tools are paused for a short while. Please try again later.',
          );
      }

      const parsed = def.schema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return render(res, def, {
          values,
          errors: fieldErrors(parsed.error),
          status: 422,
          answer: true,
          banner: { tone: 'danger', text: 'Please check the highlighted field and try again.' },
        });
      }
      const input = parsed.data;
      // A tool with two ways in (a page address or pasted code) is a different kind of run for each.
      const kind = def.kindFor ? def.kindFor(input) : def.kind;
      if (kind === 'fetch' && !svc.turnstile) return soon();

      if (kind === 'fetch') {
        const human = await svc.turnstile.verify({
          token: req.body?.['cf-turnstile-response'],
          remoteIp: req.ip,
        });
        if (!human.ok) {
          if (human.reason === 'not_configured')
            logger?.error('Turnstile has no secret key: fetch tools are closed');
          const down = human.reason === 'unavailable' || human.reason === 'not_configured';
          return refuse(
            down ? 503 : 422,
            TURNSTILE_MESSAGES[human.reason] ?? TURNSTILE_MESSAGES.rejected,
          );
        }
      }

      // Busy is checked before the limiter, so a visitor who is told to wait has not used up a check.
      if (svc.runner.inFlight() >= svc.runner.limits.inFlight) {
        res.set('Retry-After', '30');
        return refuse(
          503,
          'Lots of people are using this tool right now. Please try again in a minute.',
        );
      }

      let verdict;
      try {
        verdict = await svc.limiter.admit({
          kind,
          ip: req.ip,
          domain: kind === 'fetch' ? def.domain(input) : undefined,
        });
      } catch (err) {
        // Redis down: the tool is closed, it never opens up.
        logger?.error({ err: err.message }, 'The tool limiter is unreachable: tools are closed');
        return refuse(
          503,
          'This tool is unavailable right now. Please try again in a few minutes.',
        );
      }
      if (!verdict.allowed) {
        const refusal = REFUSALS[verdict.reason] ?? REFUSALS.blocked;
        if (verdict.retryAfterMs)
          res.set('Retry-After', String(Math.ceil(verdict.retryAfterMs / 1000)));
        const when = verdict.retryAfterMs
          ? ` You can try again in about ${formatWait(verdict.retryAfterMs)}.`
          : '';
        return refuse(refusal.status, `${refusal.text}${refusal.status === 429 ? when : ''}`);
      }

      const out = await svc.runner.run(def.run, input);
      if (out.status === 'busy') {
        res.set('Retry-After', '30');
        return refuse(
          503,
          'Lots of people are using this tool right now. Please try again in a minute.',
        );
      }
      let result;
      if (out.status === 'ok') {
        try {
          result = { status: 'ok', findings: normalizeFindings(out.result) };
        } catch (err) {
          if (!(err instanceof FindingsError)) throw err;
          logger?.error(
            { tool: def.slug, err: err.message },
            'A tool returned findings of the wrong shape',
          );
          result = {
            status: 'couldnt_check',
            reason: 'Something went wrong on our side. Try again in a minute.',
          };
        }
      } else {
        result = { status: 'couldnt_check', reason: out.reason };
      }
      // One count per run: the file button re-runs the same input, so it is not counted again. Only the tool's name
      // and whether it could check are sent, never what was typed (src/lib/funnel.js).
      if (!download) {
        funnel?.capture('tool_used', {
          tool: def.slug,
          outcome: result.status === 'ok' ? 'ok' : 'couldnt_check',
        });
      }
      if (download && result.status === 'ok' && result.findings.output) {
        const { filename, text } = result.findings.output;
        quiet(res);
        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Content-Disposition', `attachment; filename="${filename}"`);
        return res.type('text/plain; charset=utf-8').send(text);
      }
      return render(res, def, { values, result, answer: true });
    } catch (err) {
      return next(err);
    }
  };
  router.post('/tools/:slug', form, handle(false));
  router.post('/tools/:slug/download', form, handle(true));

  return router;
}

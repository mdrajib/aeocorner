import { SECTIONS, changedSections, emptyBrandKit, parseBrandKit } from '../../core/brand-kit.js';
import { DomainError } from '../../db/index.js';
import { brandKitJobId, slotOf } from '../../lib/job-ids.js';
import { notFound } from '../middleware/errors.js';
import { dateLabel, lines, rowsOf, text, withNotice } from './project-helpers.js';

/**
 * The Brand Kit screen (B8): one project's kit in four sections plus its competitors, every saved version, and "read my
 * website again". Registered on the project router, so `req.project` and the project permission checks are already in
 * place (see projects.js).
 *
 * Each section is its own form. A save merges that section into the newest kit and writes a new immutable version;
 * the form carries the version it started from, and if someone saved in between nothing is written (`STALE_VERSION`)
 * and the page says so, so one person's edit never silently erases another's.
 */

const SOURCE_LABELS = Object.freeze({
  audit: 'From your free audit',
  extracted: 'Read from your website',
  edited: 'Edited',
  reanalyzed: 'Read again from your website',
});
const TABS = Object.freeze([...Object.keys(SECTIONS), 'competitors']);

/** How long a new project may still be waiting for its first reading before the page says it didn't work. */
export const READING_WINDOW_MS = 3 * 60_000;

/** One section of the kit as the form sent it, ready for `parseBrandKit`. */
export function sectionFromBody(section, body) {
  switch (section) {
    case 'identity':
      return {
        brandName: text(body.brandName, 120),
        aliases: lines(body.aliases, 120),
        legalName: text(body.legalName, 160),
        domains: lines(body.domains, 253),
        definition: text(body.definition, 400),
        category: text(body.category, 120),
        geography: text(body.geography, 120),
      };
    case 'offerings':
      return {
        items: rowsOf(body, {
          name: ['offering_name', 120],
          url: ['offering_url', 300],
          description: ['offering_description', 400],
          price: ['offering_price', 80],
        }),
        audiences: lines(body.audiences, 160),
        differentiators: lines(body.differentiators, 200),
      };
    case 'facts':
      return rowsOf(body, { label: ['fact_label', 80], value: ['fact_value', 300] });
    case 'voice':
      return {
        tone: lines(body.tone, 40),
        readingLevel: text(body.readingLevel, 60),
        use: lines(body.use, 60),
        avoid: lines(body.avoid, 60),
        personas: rowsOf(body, {
          name: ['persona_name', 80],
          bio: ['persona_bio', 400],
          credentials: ['persona_credentials', 200],
        }),
      };
    default:
      return null;
  }
}

/** A validation message a customer can act on, with the row it is about. */
export function readableErrors(errors) {
  const out = {};
  for (const [path, message] of Object.entries(errors)) {
    const row = path.match(/^(offerings\.items|facts|voice\.personas)\.(\d+)\.(\w+)$/);
    if (row) {
      const n = Number(row[2]) + 1;
      const what = { 'offerings.items': 'Offering', facts: 'Fact', 'voice.personas': 'Author' }[
        row[1]
      ];
      const key = `${row[1]}.${row[2]}`;
      out[key] ??= `${what} ${n}: fill in both the name and the details, or clear the row.`;
    } else out[path] = message;
  }
  return out;
}

export function brandRoutes(router, { jobs, logger, appPage, edit }) {
  async function renderBrand(req, res, { kit, errors = {}, tab, conflict = false, status } = {}) {
    const [current, history, entities] = await Promise.all([
      req.orgDb.brandKits.current(req.project.id),
      req.orgDb.brandKits.history(req.project.id),
      req.orgDb.entities.list(req.project.id, { kind: 'competitor' }),
    ]);
    const waitingSince = Date.now() - new Date(req.project.created_at).getTime();
    const noKit = !current;
    const reading = noKit && Boolean(jobs) && waitingSince < READING_WINDOW_MS;
    if (reading) res.locals.refreshSeconds = 8;

    const versions = history.map((row, i) => ({
      version: row.version,
      sourceLabel: SOURCE_LABELS[row.source] ?? row.source,
      author: row.author?.name || null,
      savedOn: dateLabel(row.created_at),
      changed: changedSections(history[i + 1]?.data ?? null, row.data).map((k) => SECTIONS[k]),
      current: row.version === current?.version,
    }));
    const sectionErrors = {};
    for (const [path, message] of Object.entries(errors)) {
      const section = path.split('.')[0];
      (sectionErrors[section] ??= {})[path] = message;
    }
    return appPage(
      res,
      'project-brand',
      {
        kit:
          kit ??
          current?.data ??
          emptyBrandKit({ name: req.project.name, domain: req.project.domain }),
        version: current?.version ?? null,
        sourceLabel: current ? (SOURCE_LABELS[current.source] ?? current.source) : '',
        savedOn: current ? dateLabel(current.created_at) : '',
        tab: TABS.includes(tab) ? tab : 'identity',
        sectionErrors,
        history: versions,
        competitors: entities.filter((e) => ['active', 'paused'].includes(e.status)),
        suggested: entities.filter((e) => e.status === 'suggested'),
        reading,
        readFailed: noKit && !reading && Boolean(jobs),
        canEdit: res.locals.can('strategy.edit'),
        conflict,
        meta: {
          title: `Brand Kit · ${req.project.name} | AEO Corner`,
          description: 'The Brand Kit.',
        },
      },
      status ? { status } : {},
    );
  }

  router.get('/projects/:pid/brand', async (req, res, next) => {
    try {
      await renderBrand(req, res, { tab: req.query.tab });
    } catch (err) {
      next(err);
    }
  });

  router.post('/projects/:pid/brand', edit, async (req, res, next) => {
    try {
      const section = Object.hasOwn(SECTIONS, req.body.section) ? req.body.section : null;
      if (!section) return notFound(req, res);
      const current = await req.orgDb.brandKits.current(req.project.id);
      const base =
        current?.data ?? emptyBrandKit({ name: req.project.name, domain: req.project.domain });
      const merged = { ...base, [section]: sectionFromBody(section, req.body) };
      const parsed = parseBrandKit(merged);
      if (!parsed.ok) {
        return renderBrand(req, res, {
          kit: merged,
          errors: readableErrors(parsed.errors),
          tab: section,
          status: 422,
        });
      }
      const expected = /^\d{1,9}$/.test(String(req.body.expectedVersion))
        ? Number(req.body.expectedVersion)
        : null;
      try {
        await req.orgDb.brandKits.save(req.project.id, {
          kit: parsed.kit,
          source: 'edited',
          expectedVersion: expected,
          actorUserId: req.user.id,
        });
      } catch (err) {
        if (err instanceof DomainError && err.code === 'STALE_VERSION') {
          return renderBrand(req, res, { tab: section, conflict: true, status: 409 });
        }
        throw err;
      }
      return res.redirect(
        303,
        withNotice(`${res.locals.projectBase}/brand?tab=${section}`, 'brand-saved'),
      );
    } catch (err) {
      next(err);
    }
  });

  router.post('/projects/:pid/brand/restore', edit, async (req, res, next) => {
    try {
      const version = /^\d{1,9}$/.test(String(req.body.version)) ? Number(req.body.version) : null;
      const row = version ? await req.orgDb.brandKits.get(req.project.id, version) : null;
      if (!row) return notFound(req, res);
      const current = await req.orgDb.brandKits.current(req.project.id);
      try {
        await req.orgDb.brandKits.save(req.project.id, {
          kit: row.data,
          source: 'edited',
          expectedVersion: current?.version ?? null,
          actorUserId: req.user.id,
        });
      } catch (err) {
        if (err instanceof DomainError && err.code === 'STALE_VERSION') {
          return renderBrand(req, res, { conflict: true, status: 409 });
        }
        throw err;
      }
      return res.redirect(303, withNotice(`${res.locals.projectBase}/brand`, 'brand-restored'));
    } catch (err) {
      next(err);
    }
  });

  router.post('/projects/:pid/brand/reread', edit, async (req, res, next) => {
    try {
      const back = (notice) =>
        res.redirect(303, withNotice(`${res.locals.projectBase}/brand`, notice));
      if (!jobs) return back('queue-down');
      const current = await req.orgDb.brandKits.current(req.project.id);
      const baseVersion = current?.version ?? 0;
      try {
        await jobs.add(
          'brandkit.extract',
          { orgId: String(req.org.id), projectId: String(req.project.id), baseVersion },
          { jobId: brandKitJobId(req.project.id, baseVersion, slotOf(new Date())) },
        );
      } catch (err) {
        logger.error(
          { err, projectId: String(req.project.id) },
          'Could not queue the Brand Kit reading',
        );
        return back('queue-down');
      }
      return back('reading-site');
    } catch (err) {
      next(err);
    }
  });
}

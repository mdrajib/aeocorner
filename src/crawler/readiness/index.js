import { a1, a2, a3, a4 } from './checks-a.js';
import { b1, b2, c1, c2, c3, c4 } from './checks-bc.js';
import { d1, d2, d3, d4 } from './checks-d.js';
import { e1, e2, e3, e4, e5, e6 } from './checks-e.js';
import { f1, f2, f3, f4 } from './checks-f.js';
import { CHECK_CODES, CHECKS, finishCheck, RUBRIC_VERSION, scoreChecks } from './rubric.js';

export {
  CATEGORIES,
  CHECK_CODES,
  CHECKS,
  MIN_EVALUATED_SHARE,
  RUBRIC_VERSION,
  scoreChecks,
} from './rubric.js';
export { questionPairs } from './checks-e.js';

const RUNNERS = {
  A1: a1,
  A2: a2,
  A3: a3,
  A4: a4,
  B1: b1,
  B2: b2,
  C1: c1,
  C2: c2,
  C3: c3,
  C4: c4,
  D1: d1,
  D2: d2,
  D3: d3,
  D4: d4,
  E1: e1,
  E2: e2,
  E3: e3,
  E4: e4,
  E5: e5,
  E6: e6,
  F1: f1,
  F2: f2,
  F3: f3,
  F4: f4,
};

/**
 * Run every readiness check over what a scan gathered.
 *
 * The scan context (built by the crawler pipeline, or by hand in tests):
 *   site        { origin, domain, homeUrl }
 *   robots      { status: 'ok' | 'missing' | 'unreachable', httpStatus, parsed }
 *   sitemaps    { found: [{url, kind, urlCount}], referenced: [url], lastmods: [Date] }
 *   botProbes   null | { control, bots: [{agent, status, blocked, vendor, reason}] }
 *   llmsTxt     { status: 'present' | 'missing' | 'error', httpStatus }
 *   pages       [{ url, finalUrl, pageType, isKey, status, redirectCount, headers, facts, rendered: {facts, error}, error }]
 *   now         Date
 *
 * Every check answers on its own: one that throws (a bug, or data we didn't expect) becomes an `error` for that
 * check alone, and never stops the others or changes the score.
 */
export function runReadinessChecks(ctx) {
  const results = CHECK_CODES.map((code) => {
    try {
      return finishCheck(code, RUNNERS[code](ctx));
    } catch (err) {
      return finishCheck(code, {
        status: 'error',
        summary: 'This check hit an unexpected problem and was skipped.',
        evidence: { internalError: String(err?.message ?? err).slice(0, 200) },
      });
    }
  });
  return { rubricVersion: RUBRIC_VERSION, checks: results, ...scoreChecks(results) };
}

/** The individual check functions, for tests that exercise one check at a time. Not for production code. */
export const RUNNERS_FOR_TESTS = RUNNERS;

/** Every rubric check has a runner and every runner has a rubric entry; a test pins this. */
export const RUNNER_CODES = Object.freeze(Object.keys(RUNNERS));
export const RUBRIC_CODES = Object.freeze(Object.keys(CHECKS));

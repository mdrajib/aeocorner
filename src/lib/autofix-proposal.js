import { AUTOFIX_RULES, buildAutofix, parseExtras, sourceCheckOf } from '../core/autofix.js';
import { buildFix, PLUGIN_WITH_FIXES, pluginAtLeast } from '../core/autofix-fixes.js';
import { verifiedProfileUrls } from '../core/entity-checks.js';

/**
 * What an auto-fix would write for a recommendation, worked out from what the project holds now. The preview screen, the
 * approval and Autopilot all call this one function, so what a person previews, what they approve and what Autopilot
 * prepared are worked out the same way, and a fingerprint (`built.hash`) can tell them apart when something moved.
 *
 * Reads only; it writes nothing and sends nothing.
 *
 * @param {object} p
 * @param {object} p.scoped   `forOrg(orgId)`
 * @param {object} p.project  `{ id, name, domain }`
 * @param {object} p.rec      the recommendation (`recommendations.get(...).recommendation`)
 * @param {object} [p.input]  what a person typed on the screen: `{ logoUrl, sameAs }`; Autopilot passes nothing
 */
export async function proposeAutofix({ scoped, project, rec, input = {} }) {
  const rule = AUTOFIX_RULES[rec.ruleCode];
  const [integration, kit, [brand], change] = await Promise.all([
    scoped.integrations.wordpress(project.id),
    scoped.brandKits.current(project.id),
    scoped.entities.list(project.id, { kind: 'brand' }),
    scoped.autofix.current(project.id, rec.id),
  ]);
  const connected = integration?.status === 'connected';
  const pluginReady = connected && Boolean(integration.config?.pluginConnected);
  const extras = parseExtras({ logoUrl: input.logoUrl, sameAs: input.sameAs });
  let built = null;
  if (pluginReady && rule) {
    const homeUrl = integration.config.siteUrl;
    const identity = kit?.data?.identity ?? {};
    const brandInfo = {
      name: identity.brandName || brand?.name || project.name,
      legalName: identity.legalName,
      definition: identity.definition,
    };
    if (rule.scope === 'home') {
      // The profile links that passed our check and the founding year the customer typed: what an Organization fix may add
      // beyond what is typed on the screen (Milestone 12).
      const entityChecks = await scoped.entityChecks.checks(project.id);
      built = buildAutofix({
        ruleCode: rec.ruleCode,
        brand: brandInfo,
        homeUrl,
        domain: project.domain,
        extras: extras.ok ? extras : {},
        entity: {
          sameAs: verifiedProfileUrls(entityChecks),
          foundingYear: kit?.data?.entity?.foundingYear ?? '',
        },
        existingNodes: await scoped.autofix.appliedNodes(
          project.id,
          homeUrl.endsWith('/') ? homeUrl : `${homeUrl}/`,
        ),
      });
    } else if (!pluginAtLeast(integration.config.pluginVersion)) {
      // The page, title and robots.txt fixes use routes that arrived in plugin 1.1.0.
      built = {
        ok: false,
        outdated: true,
        reason: `The AEO Corner plugin on your site is version ${integration.config.pluginVersion ?? 'unknown'}; this fix needs ${PLUGIN_WITH_FIXES} or newer. Download the new plugin from the WordPress screen and update it, press “Check again” on that screen, then come back.`,
      };
    } else {
      const evidence = await latestEvidence(scoped, project.id, sourceCheckOf(rec.ruleCode));
      built = evidence
        ? buildFix({ ruleCode: rec.ruleCode, evidence, brand: brandInfo, homeUrl })
        : {
            ok: false,
            reason:
              'We need a finished scan of your site to build this from. Run a scan from the Setup or Readiness screen, then come back.',
          };
    }
  }
  return { rule, integration, connected, pluginReady, extras, built, change, brand: brand ?? null };
}

/** The evidence of one readiness check from the most recent scan that has it: what a page-level fix is built from. */
export async function latestEvidence(scoped, projectId, checkCode) {
  const scans = await scoped.scans.recent({ projectId, limit: 5 });
  for (const scan of scans) {
    if (!['complete', 'partial'].includes(scan.status)) continue;
    const checks = await scoped.scans.checks(scan.id);
    const found = checks.find((c) => c.check_code === checkCode);
    if (found && found.status !== 'error') return found.evidence ?? {};
  }
  return null;
}

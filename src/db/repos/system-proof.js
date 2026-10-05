/**
 * The one cross-organization read for shared proof cards (UI_DESIGN D4): the public page at `/p/:publicId` has no
 * signed-in organization, only an address. Reviewed in the tenancy coverage test.
 *
 * It returns exactly what the public page may show: the outcome's figures, the recommendation's title, the brand's name and
 * the project's domain. No question, answer, competitor, user or organization is read. A revoked share, a closed
 * organization or an archived project is the same as an address that never existed (null).
 */
export function systemProof(prisma) {
  const proofShares = {
    async byPublicId(publicId) {
      const share = await prisma.proof_shares.findFirst({
        where: {
          public_id: publicId,
          revoked_at: null,
          projects: { deleted_at: null, organizations: { deleted_at: null } },
        },
        include: {
          action_outcomes: { include: { recommendations: true } },
          projects: { select: { id: true, org_id: true, domain: true, name: true } },
        },
      });
      if (!share) return null;
      const o = share.action_outcomes;
      const rec = o.recommendations;
      const brand = await prisma.tracked_entities.findFirst({
        where: { project_id: share.projects.id, org_id: share.projects.org_id, kind: 'brand' },
        select: { name: true, primary_domain: true },
      });
      return {
        outcome: {
          horizon: o.horizon,
          engineScope: o.engine_scope,
          promptsCount: o.prompts_count,
          nBefore: o.n_before,
          kBefore: o.k_before,
          nAfter: o.n_after,
          kAfter: o.k_after,
          metric: o.metric,
          rateBefore: o.rate_before == null ? null : Number(o.rate_before),
          rateAfter: o.rate_after == null ? null : Number(o.rate_after),
          deltaPp: o.delta_pp == null ? null : Number(o.delta_pp),
          p: o.p_value == null ? null : Number(o.p_value),
          verdict: o.verdict,
          computedAt: o.computed_at,
        },
        title: rec.title,
        startedAt: rec.measuring_started_at ?? rec.done_at,
        brandName: brand?.name ?? share.projects.name,
        domain: brand?.primary_domain ?? share.projects.domain,
      };
    },
  };
  return { proofShares };
}

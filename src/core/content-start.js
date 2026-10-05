/**
 * How a recommendation becomes a Content Studio item: a new page or a refresh of an existing one, in which format, aimed at
 * which of the project's questions. Pure. The "Write this" button on the Action Center and Autopilot both start a draft
 * from this one function, so the same recommendation always starts the same draft.
 *
 * A citation gap is a NEW page in the format the cited pages have (the addresses it names are somebody else's); an uncited
 * page of the brand's own is refreshed in place; a lost question starts a new page unless the recommendation names a page.
 *
 * @param {object} rec  `{ ruleCode, title, affectedUrls, evidence }`
 * @returns {{ title: string, kind: 'new'|'refresh', targetUrl: string|null, format?: string, promptIds: string[] }}
 */
export function contentStartFor(rec) {
  const isGap = rec.ruleCode === 'citation.gap';
  const targetUrl =
    rec.ruleCode === 'visibility.lost_prompt' || isGap
      ? null
      : rec.ruleCode === 'citation.own_page_uncited'
        ? (rec.evidence?.url ?? null)
        : (rec.affectedUrls?.[0] ?? null);
  const promptIds = isGap
    ? (rec.evidence?.questions ?? []).map((q) => String(q.promptId))
    : rec.evidence?.promptId
      ? [String(rec.evidence.promptId)]
      : [];
  return {
    title: rec.title,
    kind: targetUrl ? 'refresh' : 'new',
    targetUrl,
    format: isGap ? (rec.evidence?.contentFormat ?? 'other') : undefined,
    promptIds,
  };
}

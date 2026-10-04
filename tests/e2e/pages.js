// Page registry for the accessibility and responsive sweeps (BUILD_PLAN §2, UI rule).
// Every phase that adds a screen registers it here, so the sweeps cover it with no extra work.
// Public pages come straight from src/web/pages.js, so a new public page is covered automatically.
import { publicPages } from '../../src/web/pages.js';

/** @type {{ name: string, path: string, status?: number, audience: 'public' | 'dev' }[]} */
export const pages = [
  ...publicPages.map((p) => ({ name: p.name ?? p.view, path: p.path, audience: 'public' })),
  { name: 'not-found', path: '/this-page-does-not-exist', status: 404, audience: 'public' },
  {
    name: 'unsubscribe-invalid',
    path: '/unsubscribe/not-a-token',
    status: 404,
    audience: 'public',
  },
  { name: 'styleguide', path: '/_styleguide', audience: 'dev' },
  { name: 'app-shell', path: '/_styleguide/app-shell', audience: 'dev' },
];

export const publicSitePages = pages.filter((p) => p.audience === 'public');

// Signed-in screens and the invitation page. They need data, so each path is a function of the ids the e2e
// server seeded (tests/e2e/server.js, served at /__e2e/fixtures). `as` is who to sign in as first (null = anonymous).
/** @type {{ name: string, as: string | null, status?: number, path: (f: any) => string }[]} */
export const appPages = [
  { name: 'new-org', as: 'newcomer', path: () => '/app/new-org' },
  { name: 'org-home', as: 'owner', path: (f) => `/app/o/${f.orgId}` },
  { name: 'project-new', as: 'owner', path: (f) => `/app/o/${f.orgId}/projects/new` },
  { name: 'project-home', as: 'owner', path: (f) => `/app/o/${f.orgId}/projects/${f.projectId}` },
  {
    name: 'project-home-viewer',
    as: 'viewer',
    path: (f) => `/app/o/${f.orgId}/projects/${f.projectId}`,
  },
  {
    name: 'project-home-incomplete-check',
    as: 'owner',
    path: (f) => `/app/o/${f.orgId}/projects/${f.incompleteProjectId}`,
  },
  {
    name: 'project-home-running-check',
    as: 'owner',
    path: (f) => `/app/o/${f.orgId}/projects/${f.runningProjectId}`,
  },
  {
    name: 'project-home-incomplete-check-viewer',
    as: 'viewer',
    path: (f) => `/app/o/${f.orgId}/projects/${f.incompleteProjectId}`,
  },
  {
    name: 'project-setup-start-tracking-on',
    as: 'owner',
    path: (f) => `/app/o/${f.orgId}/projects/${f.incompleteProjectId}/setup/start`,
  },
  {
    name: 'project-brand',
    as: 'owner',
    path: (f) => `/app/o/${f.orgId}/projects/${f.projectId}/brand`,
  },
  {
    name: 'project-brand-viewer',
    as: 'viewer',
    path: (f) => `/app/o/${f.orgId}/projects/${f.projectId}/brand`,
  },
  {
    name: 'project-questions',
    as: 'owner',
    path: (f) => `/app/o/${f.orgId}/projects/${f.projectId}/questions`,
  },
  {
    name: 'project-questions-viewer',
    as: 'viewer',
    path: (f) => `/app/o/${f.orgId}/projects/${f.projectId}/questions`,
  },
  {
    name: 'question-edit',
    as: 'owner',
    path: (f) => `/app/o/${f.orgId}/projects/${f.projectId}/questions/${f.promptId}/edit`,
  },
  ...['brand', 'competitors', 'questions', 'connect', 'start'].map((step) => ({
    name: `project-setup-${step}`,
    as: 'owner',
    path: (f) => `/app/o/${f.orgId}/projects/${f.projectId}/setup/${step}`,
  })),
  // The dashboard screens (Milestone 5): with a finished check that was partly unreadable, with none, and before tracking.
  ...['dashboard', 'answers', 'compare', 'citations'].flatMap((screen) => [
    {
      name: `project-${screen}`,
      as: 'owner',
      path: (f) => `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/${screen}`,
    },
    {
      name: `project-${screen}-viewer`,
      as: 'viewer',
      path: (f) => `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/${screen}`,
    },
    {
      name: `project-${screen}-no-results`,
      as: 'owner',
      path: (f) => `/app/o/${f.orgId}/projects/${f.incompleteProjectId}/${screen}`,
    },
    {
      name: `project-${screen}-tracking-off`,
      as: 'owner',
      path: (f) => `/app/o/${f.orgId}/projects/${f.projectId}/${screen}`,
    },
  ]),
  {
    name: 'project-answer-detail',
    as: 'owner',
    path: (f) =>
      `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/answers/${f.dashboardPromptId}`,
  },
  {
    name: 'project-answer-detail-viewer',
    as: 'viewer',
    path: (f) =>
      `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/answers/${f.dashboardPromptId}`,
  },
  // The Action Center (Milestone 6): the list in each state, an open recommendation, and one with a proven result.
  ...['todo', 'progress', 'results'].map((view) => ({
    name: `project-actions-${view}`,
    as: 'owner',
    path: (f) => `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/actions?view=${view}`,
  })),
  {
    name: 'project-actions-viewer',
    as: 'viewer',
    path: (f) => `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/actions`,
  },
  {
    name: 'project-content',
    as: 'owner',
    path: (f) => `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/content`,
  },
  {
    name: 'project-content-viewer',
    as: 'viewer',
    path: (f) => `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/content`,
  },
  {
    name: 'project-content-empty',
    as: 'owner',
    path: (f) => `/app/o/${f.orgId}/projects/${f.incompleteProjectId}/content`,
  },
  {
    name: 'content-item-ready',
    as: 'owner',
    path: (f) => `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/content/${f.contentReadyId}`,
  },
  {
    name: 'content-item-ready-viewer',
    as: 'viewer',
    path: (f) => `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/content/${f.contentReadyId}`,
  },
  {
    name: 'content-item-approved',
    as: 'owner',
    path: (f) =>
      `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/content/${f.contentApprovedId}`,
  },
  {
    name: 'content-item-published',
    as: 'owner',
    path: (f) =>
      `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/content/${f.contentPublishedId}`,
  },
  {
    name: 'content-item-working',
    as: 'owner',
    path: (f) => `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/content/${f.contentWorkingId}`,
  },
  {
    name: 'content-item-failed',
    as: 'owner',
    path: (f) => `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/content/${f.contentFailedId}`,
  },
  {
    name: 'wordpress-connect',
    as: 'owner',
    path: (f) => `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/integrations/wordpress`,
  },
  {
    name: 'wordpress-connected',
    as: 'admin',
    path: (f) => `/app/o/${f.orgId}/projects/${f.projectId}/integrations/wordpress`,
  },
  {
    name: 'wordpress-viewer',
    as: 'viewer',
    path: (f) => `/app/o/${f.orgId}/projects/${f.projectId}/integrations/wordpress`,
  },
  // Plan and billing, email choices and AI traffic (Milestone 8). The unsubscribe link needs no sign-in (`as: null`).
  { name: 'unsubscribe-confirm', as: null, path: (f) => `/unsubscribe/${f.unsubscribeToken}` },
  { name: 'billing', as: 'owner', path: (f) => `/app/o/${f.orgId}/billing` },
  { name: 'notifications', as: 'owner', path: (f) => `/app/o/${f.orgId}/notifications` },
  { name: 'notifications-viewer', as: 'viewer', path: (f) => `/app/o/${f.orgId}/notifications` },
  {
    name: 'traffic',
    as: 'owner',
    path: (f) => `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/traffic`,
  },
  {
    name: 'traffic-viewer',
    as: 'viewer',
    path: (f) => `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/traffic`,
  },
  {
    name: 'traffic-choose',
    as: 'owner',
    path: (f) => `/app/o/${f.orgId}/projects/${f.runningProjectId}/traffic`,
  },
  {
    name: 'traffic-connect',
    as: 'owner',
    path: (f) => `/app/o/${f.orgId}/projects/${f.incompleteProjectId}/traffic`,
  },
  {
    name: 'project-actions-empty',
    as: 'owner',
    path: (f) => `/app/o/${f.orgId}/projects/${f.incompleteProjectId}/actions`,
  },
  {
    name: 'project-action-open',
    as: 'owner',
    path: (f) => `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/actions/${f.actionOpenId}`,
  },
  {
    name: 'project-action-open-viewer',
    as: 'viewer',
    path: (f) => `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/actions/${f.actionOpenId}`,
  },
  {
    name: 'project-action-autofix',
    as: 'owner',
    path: (f) =>
      `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/actions/${f.actionAutofixId}/autofix`,
  },
  {
    name: 'project-action-autofix-viewer',
    as: 'viewer',
    path: (f) =>
      `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/actions/${f.actionAutofixId}/autofix`,
  },
  {
    name: 'project-action-proven-win',
    as: 'owner',
    path: (f) => `/app/o/${f.orgId}/projects/${f.dashboardProjectId}/actions/${f.actionWinId}`,
  },
  {
    name: 'member-access',
    as: 'owner',
    path: (f) => `/app/o/${f.orgId}/members/${f.membershipId}/access`,
  },
  { name: 'team', as: 'owner', path: (f) => `/app/o/${f.orgId}/settings` },
  { name: 'team-no-access', as: 'viewer', status: 403, path: (f) => `/app/o/${f.orgId}/settings` },
  { name: 'invite-signed-out', as: null, path: (f) => `/invite/${f.tokens.signedOut}` },
  { name: 'invite-accept', as: 'invitee', path: (f) => `/invite/${f.tokens.accept}` },
  { name: 'invite-wrong-account', as: 'owner', path: (f) => `/invite/${f.tokens.accept}` },
  { name: 'invite-expired', as: null, path: (f) => `/invite/${f.tokens.expired}` },
  { name: 'invite-unknown', as: null, status: 404, path: (f) => `/invite/${f.unknownToken}` },
];

// The free audit's own screens. The email step only exists as the answer to the form, so each entry says how to get to
// its page: `open(page, fixtures)`. The audits are the ones tests/e2e/server.js seeded (queued, running, finished,
// partial, failed), so no engine or worker is involved.
/** @type {{ name: string, open: (page: import('@playwright/test').Page, f: any) => Promise<unknown> }[]} */
export const auditPages = [
  {
    name: 'audit-email',
    open: async (page) => {
      await page.goto('/');
      await page.locator('#hero-url').fill('example.com');
      await page.getByRole('button', { name: 'Run my free audit' }).first().click();
      await page
        .getByRole('heading', { level: 1, name: 'Where should we send your report?' })
        .waitFor();
    },
  },
  { name: 'audit-verify', open: (page, f) => page.goto(`/audit/${f.audits.awaiting}/verify`) },
  { name: 'audit-progress', open: (page, f) => page.goto(`/audit/${f.audits.running}/progress`) },
  { name: 'audit-report', open: (page, f) => page.goto(`/r/${f.audits.complete}`) },
  { name: 'audit-report-partial', open: (page, f) => page.goto(`/r/${f.audits.partial}`) },
  { name: 'audit-report-failed', open: (page, f) => page.goto(`/r/${f.audits.failed}`) },
];

export async function openAuditPage(page, request, entry) {
  const fixtures = await (await request.get('/__e2e/fixtures')).json();
  return entry.open(page, fixtures);
}

/** Open a signed-in page: sign in as the right person, then land on the page. Returns the final response. */
export async function openAppPage(page, request, entry) {
  const fixtures = await (await request.get('/__e2e/fixtures')).json();
  const path = entry.path(fixtures);
  const target = entry.as ? `/__e2e/login?as=${entry.as}&next=${encodeURIComponent(path)}` : path;
  return page.goto(target);
}

export const viewportWidths = [375, 768, 1280];

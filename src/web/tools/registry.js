import { toolDefinitions } from './index.js';

/**
 * The public pages the tools add to the registry (`src/web/pages.js`): the hub and one page per tool. They are served by
 * `routes/tools.js` rather than the generic page loop (`own: true`), because a tool page also takes a POST. With no tool
 * listed in `index.js` there are no pages: no empty hub in the sitemap.
 *
 * The hub's description is built from the tools that are listed, so it never names a tool that does not exist yet.
 */
export function hubDescription(definitions = toolDefinitions) {
  const names = definitions.map((t) => t.crumb);
  const all = `Free tools for AI search: ${names.join(', ')}. No account needed.`;
  if (all.length <= 165) return all;
  return `Free tools for AI search, including ${names.slice(0, 3).join(', ')} and more. No account needed.`;
}

export const hubPageFor = (definitions = toolDefinitions) => ({
  path: '/tools',
  view: 'tools-hub',
  crumb: 'Free tools',
  title: 'Free AEO tools for AI search | AEO Corner',
  description: hubDescription(definitions),
  lastmod: '2026-10-06',
  priority: 0.8,
  own: true,
});

export const toolPage = (tool) => ({
  path: `/tools/${tool.slug}`,
  view: 'tool',
  name: `tool-${tool.slug}`,
  crumb: tool.crumb,
  tool: tool.slug,
  title: tool.title,
  description: tool.description,
  lastmod: tool.lastmod,
  priority: 0.7,
  own: true,
});

export const toolPages = (definitions = toolDefinitions) =>
  definitions.length ? [hubPageFor(definitions), ...definitions.map(toolPage)] : [];

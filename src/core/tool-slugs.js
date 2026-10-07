/**
 * The free tools' addresses, as the funnel may name them (Milestone 17, task 17.13). The funnel's property allow-list takes
 * only these, so a visitor can never put their own text into an analytics event. A new tool is added here when it is listed
 * in `src/web/tools/index.js`: a route test fails until it is.
 */
export const TOOL_SLUGS = Object.freeze([
  'robots-txt-checker',
  'structured-data-validator',
  'sitemap-checker',
  'robots-txt-generator',
  'schema-markup-generator',
  'llms-txt-generator',
]);

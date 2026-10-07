import { llmsTxtGenerator } from './llms-txt-generator.js';
import { robotsTxtChecker } from './robots-txt-checker.js';
import { robotsTxtGenerator } from './robots-txt-generator.js';
import { schemaMarkupGenerator } from './schema-markup-generator.js';
import { sitemapChecker } from './sitemap-checker.js';
import { structuredDataValidator } from './structured-data-validator.js';

/**
 * The free tools that are live (ADR-0017, Milestone 17). A tool is one module in this folder that exports its
 * definition (see `src/web/routes/tools.js` for the contract); it appears on the site, in the sitemap and in the browser
 * sweeps when it is listed here, and not before. Nothing is listed until its tool is built and tested.
 */
export const toolDefinitions = [
  robotsTxtChecker,
  structuredDataValidator,
  sitemapChecker,
  robotsTxtGenerator,
  schemaMarkupGenerator,
  llmsTxtGenerator,
];

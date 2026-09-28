-- =====================================================================
-- AEO Corner: reference data for schema v1
-- Run after schema.sql. Idempotent (re-running updates rows in place).
-- Values come from docs/MVP.md 6.2 (engines and providers) and 12.3
-- (plans, a pricing HYPOTHESIS to validate with design partners).
-- NULL limits are not defined yet; set them before launch.
-- =====================================================================

SET NAMES utf8mb4;
SET time_zone = '+00:00';

INSERT INTO providers (code, name, kind, status) VALUES
  ('dataforseo',     'DataForSEO',            'answer_data', 'active'),
  ('perplexity_api', 'Perplexity Sonar API',  'answer_data', 'active'),
  ('serpapi',        'SerpApi',               'answer_data', 'active'),
  ('gemini_api',     'Gemini API',            'answer_data', 'active'),
  -- Enable only when the ChatGPT fallback is switched on (adds OpenAI as a subprocessor, MVP 11.3).
  ('openai_api',     'OpenAI Responses API',  'answer_data', 'disabled'),
  ('anthropic',      'Anthropic Claude API',  'llm',         'active')
AS new
ON DUPLICATE KEY UPDATE name = new.name, kind = new.kind;

INSERT INTO engines
  (code, name, status, query_field, default_samples,
   primary_provider_code, primary_method, fallback_provider_code, fallback_method, sort_order) VALUES
  ('chatgpt',        'ChatGPT',             'active',   'text',         3, 'dataforseo',     'ui_capture',   'openai_api', 'api_grounded', 10),
  ('perplexity',     'Perplexity',          'active',   'text',         3, 'perplexity_api', 'api_grounded', 'dataforseo', 'api_grounded', 20),
  ('gemini',         'Gemini',              'active',   'text',         3, 'dataforseo',     'ui_capture',   'gemini_api', 'api_grounded', 30),
  ('google_aio',     'Google AI Overviews', 'active',   'search_query', 1, 'serpapi',        'serp',         'dataforseo', 'serp',         40),
  -- v1.1 engines: providers are chosen when they are built.
  ('claude',         'Claude',              'disabled', 'text',         3, NULL, NULL, NULL, NULL, 50),
  ('copilot',        'Microsoft Copilot',   'disabled', 'text',         3, NULL, NULL, NULL, NULL, 60),
  ('google_ai_mode', 'Google AI Mode',      'disabled', 'search_query', 3, NULL, NULL, NULL, NULL, 70),
  ('grok',           'Grok',                'disabled', 'text',         3, NULL, NULL, NULL, NULL, 80),
  ('meta_ai',        'Meta AI',             'disabled', 'text',         3, NULL, NULL, NULL, NULL, 90)
AS new
ON DUPLICATE KEY UPDATE
  name = new.name, query_field = new.query_field, default_samples = new.default_samples,
  primary_provider_code = new.primary_provider_code, primary_method = new.primary_method,
  fallback_provider_code = new.fallback_provider_code, fallback_method = new.fallback_method,
  sort_order = new.sort_order;

INSERT INTO plans
  (code, name, price_usd_month, max_projects, max_prompts, max_seats, drafts_per_month,
   runs_now_per_month, samples_per_engine, features, is_public, sort_order) VALUES
  ('starter', 'Starter',  79.00,  1,  50, NULL,  4.0, NULL, 3,
     JSON_OBJECT('wordpress', TRUE, 'ga4', TRUE, 'alerts', FALSE, 'csv_export', FALSE,
                 'client_seats', FALSE, 'daily_addon', TRUE, 'white_label', FALSE), TRUE, 10),
  ('growth',  'Growth',  249.00,  3, 150, NULL, 15.0, NULL, 3,
     JSON_OBJECT('wordpress', TRUE, 'ga4', TRUE, 'alerts', TRUE, 'csv_export', TRUE,
                 'client_seats', FALSE, 'daily_addon', TRUE, 'white_label', FALSE), TRUE, 20),
  ('agency',  'Agency',  599.00, 10, 500, NULL, 40.0, NULL, 3,
     JSON_OBJECT('wordpress', TRUE, 'ga4', TRUE, 'alerts', TRUE, 'csv_export', TRUE,
                 'client_seats', TRUE, 'daily_addon', TRUE, 'white_label', FALSE), TRUE, 30)
AS new
ON DUPLICATE KEY UPDATE
  name = new.name, price_usd_month = new.price_usd_month, max_projects = new.max_projects,
  max_prompts = new.max_prompts, drafts_per_month = new.drafts_per_month,
  samples_per_engine = new.samples_per_engine, features = new.features, sort_order = new.sort_order;

-- A few well-known citation domains so the leaderboard is useful from day one.
-- The LLM classifier and staff review fill in the rest.
INSERT INTO web_domains (domain, class, class_source) VALUES
  ('wikipedia.org',  'reference',   'seed'),
  ('wikidata.org',   'reference',   'seed'),
  ('reddit.com',     'ugc',         'seed'),
  ('quora.com',      'ugc',         'seed'),
  ('youtube.com',    'social',      'seed'),
  ('linkedin.com',   'social',      'seed'),
  ('g2.com',         'review_site', 'seed'),
  ('capterra.com',   'review_site', 'seed'),
  ('trustpilot.com', 'review_site', 'seed'),
  ('yelp.com',       'review_site', 'seed'),
  ('crunchbase.com', 'directory',   'seed'),
  ('forbes.com',     'media',       'seed'),
  ('amazon.com',     'ecommerce',   'seed')
AS new
ON DUPLICATE KEY UPDATE class = new.class, class_source = new.class_source;

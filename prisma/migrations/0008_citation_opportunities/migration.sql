-- Citation opportunities (Milestone 13, tasks 13.03 and 13.07).
--
-- web_urls (the global URL dictionary) gains what we learned by reading a frequently cited page once: its format (a list,
-- a comparison, a review, a guide, a FAQ, documentation, or 'other' when the page gave no sign) and a few counts that make it easy to cite. `page_format` NULL means
-- "not read yet or could not be read"; `format_finding` says why when the last attempt could not look ('robots',
-- 'blocked', 'unavailable', 'fetch_failed', 'unreadable'), and is NULL after a good read. A page we could not look at is
-- never given a format. The table is global (no org_id): it holds only public pages and what they look like.
--
-- recommendations and action_outcomes gain `metric`, the figure a fix is judged on. 'mention_rate' is every fix so far
-- (k = answers that named the brand, n = readable answers). 'citation_share' is a citation fix (k = citations of the
-- brand's own site, n = all citations in those answers). The same significance test judges both. Existing rows keep
-- 'mention_rate'. New ENUM values are appended at the end, as everywhere else.

ALTER TABLE web_urls
  ADD COLUMN page_format ENUM('list','comparison','review','guide','documentation','faq','other') NULL
    COMMENT 'what the page is, read once; NULL = not read or could not look',
  ADD COLUMN format_checked_at DATETIME(3) NULL,
  ADD COLUMN format_finding VARCHAR(32) NULL COMMENT 'why the last read could not look; NULL after a good read',
  ADD COLUMN citable_signals JSON NULL COMMENT 'author, dated, sourcesLinked, figures: what makes the page easy to cite',
  ADD KEY ix_web_urls_format_check (format_checked_at);

ALTER TABLE recommendations
  ADD COLUMN metric ENUM('mention_rate','citation_share') NOT NULL DEFAULT 'mention_rate'
    COMMENT 'the figure a fix is judged on';

ALTER TABLE action_outcomes
  ADD COLUMN metric ENUM('mention_rate','citation_share') NOT NULL DEFAULT 'mention_rate'
    COMMENT 'the figure this outcome measured';

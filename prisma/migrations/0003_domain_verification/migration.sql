-- Milestone 3, task 3.04: a customer proves they own a project's website before we ignore its robots.txt
-- (docs/adr/0005-fetching-other-peoples-websites.md). The token is what they put in a DNS TXT record or a file on the
-- site; `domain_verified_at` is set when we saw it. All three columns are nullable (expand-only, online DDL), so
-- existing projects are simply "not verified yet" and get a token the first time they ask for one.
ALTER TABLE projects
  ADD COLUMN domain_verify_token  CHAR(32) NULL COMMENT 'random proof-of-ownership token; NULL until first requested',
  ADD COLUMN domain_verified_at   DATETIME(3) NULL COMMENT 'when ownership was proven; NULL = not verified',
  ADD COLUMN domain_verify_method ENUM('dns','file') NULL COMMENT 'how it was proven',
  ALGORITHM=INSTANT;

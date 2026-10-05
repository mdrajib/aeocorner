✅ 2026-10-05 ✅ 2026-10-05 ✅ 2026-10-05 ✅ 2026-10-05 ✅ 2026-10-05 ✅ 2026-10-05 ✅ 2026-10-05 ✅ 2026-10-05 ✅ 2026-10-05 # AEO Corner — Milestones for the partly covered services (Milestones 11–16) (migration `0009`: `recovery_cases` and `recovery_events`. The open key (`metric:engine`) is unique per project while the case is open and NULL after, tied to `status` by a CHECK, so a decline opens exactly one case. Metrics: mention rate, share of voice, citation share. Decided in [ADR-0015](adr/0015-visibility-recovery-cases.md)) (`judgeDecline` and `findLastingDeclines` in `src/core/recovery.js`. **F4 defaults, until the founder picks:** significant in the 28-vs-28 window and the latest 14 days (at least 10 answers) still at least 5 points below the earlier range; a drop on one engine counts. A fall that has come back is `noise`, one with too few recent answers is `pending`, never "no decline"; unfinished engine days are left out as in `trends.js`. `selectDeclines` folds a one-engine decline into the all-engines one and share of voice into mention rate)) (`diagnose`: seven causes (a change we made, a readiness check that stopped passing, an earlier fix that is gone, lost citations, a competitor's gain, an engine that stopped showing an answer, an engine-wide move), each a list of facts written by code. A cause is named on two or more facts that outnumber the facts against it (`strong` at three with none against, else `likely`); otherwise "can't tell". No model is involved)) (`recovery.recheck` (queue `crawl`): a fresh scan as its own row (trigger `verification`) and each earlier fix looked at, a fix with a readiness check by that check in the fresh scan, a published page by a fetch read with `judgeLivePage`; "couldn't look" is `unknown`, never `gone`. **Differs from the plan:** it reads the fix's own check rather than reusing `fix.verify`, which would write a verification row for a fix that is not being verified)) (`repairsFor`: an undo of our own change, a fix to do again, or the open recommendations of the matching rules, resolved in `recovery.repairProgress`; a cause with no repair on our side says so. The SEO-safe rule is `FORBIDDEN_REPAIRS` / `seoSafe`, stated on the screen)) (`decideClose`: `recovered` when the latest 14 days are back inside the earlier range by the same test and a linked repair was done since the case opened, `closed_noise` ("recovered by itself") with nothing done, `closed_unknown` after 56 days. The "Recovered" proof card is on the case page; it is not shareable publicly)) (`/projects/:pid/recovery` and `/recovery/:cid` (the case's public id), read-only, with a "Recovery" tab. **The wireframe in UI_DESIGN §5.4 (D8) is a proposal: the founder has not signed it off.** Axe and 375/768/1280 sweeps cover the list, three cases and the empty state)) (the alert goes through the notifier under the plan's `alerts` feature, once per case, and replaces the plain drop alert for the same measure; a held-back email is tried again the next day rather than lost. The digest names an open case, and a recovery in the week it happens)) (`src/core/recovery.eval.test.js`: planted causes, histories with none and 150 seeded random inputs; every named cause must point at something that was in the input))

| | |
|---|---|
| **Document** | Plan for the five services on [aeoengine.ai/services](https://aeoengine.ai/services) that AEO Corner covers only in part: LLM visibility (#5, "mostly"), agentic SEO (#6), entity optimization (#7), AI citation optimization (#9) and AI visibility recovery (#11) |
| **Date** | 2026-10-04 |
| **Status** | **Milestone 11 (wider Auto-fix) is built and tested on stand-ins and on a real WordPress (2026-10-04); open on it: a first real fix on a customer's site and submitting plugin 1.1.0 to WordPress.org. Milestone 12 (entity checks and guidance) is built and tested (2026-10-04); open on it: the founder's sign-off of the Entity wireframe, a first live run of the About page drafting, and the choice about a profile we can never read ([ADR-0013](adr/0013-entity-checks-and-guidance.md)). Milestone 13 (citation opportunities) is built and tested (2026-10-05); open on it: a first run of the new brief and the page-to-beat prompt against the live model, the founder's sign-off of the three-view Citations wireframe, and the ICE priors for the two new rules, which are guesses ([ADR-0014](adr/0014-citation-opportunities.md)). Milestone 14 (visibility recovery cases) is built and tested (2026-10-05); open on it: the founder's answer to F4 (the days and whether a one-engine drop counts; the defaults stand until then), the founder's sign-off of the Recovery wireframe (D8), and a first case on a real project ([ADR-0015](adr/0015-visibility-recovery-cases.md)). Milestones 15–16 are planned and not started.** Work on a milestone begins only when the founder asks for it. Milestones 0–10 in [MILESTONES.md](MILESTONES.md) come first for launch; this plan is the roadmap after them |
| **Companion docs** | [MILESTONES.md](MILESTONES.md) (conventions, Milestones 0–10) · [MVP.md](MVP.md) · [UI_DESIGN.md](UI_DESIGN.md) · [DATABASE_SCHEMA.md](DATABASE_SCHEMA.md) · [adr/0006-engine-adapters.md](adr/0006-engine-adapters.md) · [adr/0010-recommendations-and-proof.md](adr/0010-recommendations-and-proof.md) · [adr/0011-content-studio-and-wordpress.md](adr/0011-content-studio-and-wordpress.md) · [CLAUDE.md](../CLAUDE.md) |

## 1. What this plan is for

On 2026-10-04 we compared AEO Corner with the 12 services on aeoengine.ai. Four are fully built (answer engine optimization, generative engine optimization, schema markup, AI search analytics). Three are out of scope for a self-serve product (the managed AEO agency, AI-assisted classic SEO, SEO + AEO). Five are partly built, and this plan finishes the part that software can do.

| Service | Where we are today | What is missing | Milestone |
|---|---|---|---|
| #5 LLM visibility optimization | Four engines measured: ChatGPT, Perplexity, Gemini, Google AI Overviews | Claude is not measured | **16** |
| #6 Agentic SEO | Content Studio writes a draft and Auto-fix writes JSON-LD, but only when a person starts and approves each step | Preparing work on its own each week, a review inbox, safe limits | **15** |
| #7 Entity optimization | Brand entity, aliases, competitors, Brand Kit; checks D1–D4 and an Organization check | Checking the brand's profiles, whether engines describe it correctly, fill-in-the-blank guidance per profile | **12** |
| #9 AI citation optimization | Citations screen, citation gaps, recommendations | Source types, which of the brand's own pages get cited, citable-page briefs, citation share as a proof metric | **13** |
| #11 AI visibility recovery | Significance-tested change detection, alerts, recommendations, re-checks, proof | A "case" for a lasting decline: a diagnosis with evidence, a recovery plan and a way to close it | **14** |

One more milestone widens what Auto-fix can change. It is not a service of its own, but #6, #7 and #11 all use it, so it comes first.

| Added | Milestone |
|---|---|
| Auto-fix beyond the home page's two JSON-LD blocks: key-page schema, titles and descriptions, `robots.txt` lines | **11** |

**Not in this plan, on purpose:** the managed agency (#2), AI-assisted classic SEO (#3), Google ranking tracking and SEO + AEO (#12). They need people or a different product, and the marketing copy must keep saying so ([CLAUDE.md](../CLAUDE.md), "Marketing site").

## 2. Overview

| # | Milestone | Services | Size | Needs |
|---|---|---|---|---|
| 11 | Wider Auto-fix | #6, #7, #8 | Medium | Milestones 7 and 10 |
| 12 | Entity checks and guidance | #7 | Medium | 11 (for the `sameAs` fix); the checks can start without it |
| 13 | Citation opportunities | #9 | Medium | Milestone 6 |
| 14 | Visibility recovery cases ✅ 2026-10-05 | #11 | Large | 11 (to re-verify earlier fixes), Milestone 8 alerts |
| 15 | Autopilot | #6 | Large | 11, 13, 14 and a founder decision (15.01) |
| 16 | Claude as a fifth engine | #5 | Small to medium | Founder decision (16.01); independent of the rest |

**Suggested order:** 11 → 12 and 13 in parallel → 14 → 15, with 16 slotted in whenever the founder decides what "Claude" should mean and accepts the cost. Sizes are relative: Small is a few tasks that reuse existing parts, Large adds a new table and a new screen.

```mermaid
flowchart LR
  M11[11 Wider Auto-fix] --> M12[12 Entity]
  M11 --> M14[14 Recovery]
  M6[Action Center, done] --> M13[13 Citations]
  M11 --> M15[15 Autopilot]
  M13 --> M15
  M14 --> M15
  M16[16 Claude engine]
```

## 3. Rules these milestones keep

They add no new rules. They are the existing ones in [CLAUDE.md](../CLAUDE.md), listed because each milestone touches them.

- **A model writes words, code decides facts.** Entity checks, source types, diagnoses and fixes are decided in `src/core`; Claude may only word what code has already decided, and its reply is dropped if it adds a fact.
- **"Couldn't check" is never "failed" or 0.** This covers every new check: a profile that blocks our fetch, a Wikidata lookup that times out, a diagnosis with too little data.
- **Only a person approves a change to a customer's site, and approval pins what was shown** (the fingerprint). Milestone 15 is the one place that could weaken this, which is why 15.01 is a founder decision with an ADR.
- **Only the system verifies and judges.** New fixes use the same re-check and outcome machinery.
- **Tenancy, safe fetcher, `callProvider`, strict CSP, component kit, leak tests, `tests/e2e/pages.js`** apply to every task, as in MILESTONES.md §1.
- **The marketing copy claims only what ships.** Each milestone ends with a copy review; a page is changed in the same pass that the feature lands, never before.

## 4. Founder decisions this plan needs

| # | Decision | Needed by | Options and a recommendation |
|---|---|---|---|
| F1 | How autonomous is "Autopilot"? | 15.01 | **A (recommended):** it prepares fixes and drafts each week and a person approves in one inbox. **B:** a person sets a standing approval for low-risk JSON-LD fixes on a verified domain, with a daily cap and automatic undo. B changes the rule that every change is approved by a person, so it needs an ADR and a plain statement in the product |
| F2 | What does "Claude" mean as an engine? | 16.01 | **A (recommended):** the Claude API with its web-search tool on, which is close to what a person gets in claude.ai with search. **B:** the model alone, with no search; cheaper, but it can't cite anything. Either way it costs more per prompt-run, which is already above the $0.12 target |
| F3 | Which plans get which of these? | 11–16 | Ties to the open plan limits (task 0.17). Suggested: Auto-fix breadth and Recovery on the paid tiers, Claude as an add-on or on the top tier, Autopilot on the top two |
| F4 | When does a drop count as "lasting"? | 14.02 | Suggested: significant in the 28-vs-28 window and still lower over the most recent 14 days. Founder picks the days and whether a one-engine drop counts. **Built 2026-10-05 with these defaults, awaiting the founder's answer:** at least 5 points below the earlier range over the latest 14 days (10 answers or more), and a one-engine drop counts (`RECOVERY` in `src/core/recovery.js`; a change is one line) |
| F5 | Existing projects and the new engine | 16.05 | Suggested: not added automatically (it costs money), offered once per project |

## Milestone 11 — Wider Auto-fix

**Goal:** a customer with the WordPress plugin can approve more kinds of fix than "home-page Organization and WebSite JSON-LD", each with the same approval screen, fingerprint, undo and same-day re-check.

**Pre-requisites:** Milestones 7 and 10. Today Auto-fix offers only `readiness.C1` and `readiness.C4` (`AUTOFIX_RULES`); `readiness.A1` (crawlers allowed), `A4` (sitemap), `C2` (page-type schema) and `F3` (titles and descriptions) keep steps plus "Mark as done".

| # | Task | Needs |
|---|---|---|
| 11.01 | ✅ 2026-10-04 🔒 Read the plugin and decide the new set, with an addendum to ADR-0011: what the plugin can change today (titles and descriptions already exist), what needs a new route (`robots.txt` lines, schema on pages other than home), and what stays guidance (the sitemap: WordPress already serves one, so we report, we don't write) (Read the plugin and decide the new set. Decided in [ADR-0011](adr/0011-content-studio-and-wordpress.md)'s 2026-10-04 addendum: the plugin already had schema for any address and titles; it gained `state` and `robots` routes (1.1.0)) | — |
| 11.02 | ✅ 2026-10-04 Generalise `site_changes` to carry a kind (`jsonld`, `meta`, `robots`) and a `previous_value` that fits each kind, so undo knows what to put back. Migration `0007`, SQL-first, applied to dev and test (No migration was needed: `site_changes.kind` already has `meta` and `robots_txt`, and `previous_value` is JSON. The job saves what the plugin held (`savePrevious`) once, before it writes) | 11.01 |
| 11.03 | ✅ 2026-10-04 Key-page schema for `readiness.C2`: choose key pages from the latest scan, build WebPage, Article, FAQPage or Product JSON-LD from what the page itself says (`content-schema.js`), validate with `jsonld.js`. Nothing invented. One block per address, as the plugin already does (Key-page schema: Article, Service, Product, AboutPage and ContactPage from the page's own headline, description or first paragraph and stated dates (`buildPageSchemaFix`); a FAQ and a price page are left out and say why. A page's other structured data is kept) | 11.01 |
| 11.04 | ✅ 2026-10-04 Titles and descriptions for `readiness.F3`: propose a unique title and description for each page missing one, built in code from the page's own headline and first paragraph. Show before and after; the plugin stores the old values for undo (Titles (at most 60 characters) and descriptions (at most 155) in code, never replacing a good title (`buildMetaFix`); a before and after table) | 11.02 |
| 11.05 | ✅ 2026-10-04 `robots.txt` lines for `readiness.A1`: add the Allow lines for the answer crawlers through WordPress's virtual `robots.txt`. If the site has a real file on disk, show the exact lines as guidance instead. Show the exact result; undo removes only our lines (Allow lines for crawlers blocked from the whole site (`buildRobotsFix`), added through the robots.txt WordPress builds. **Differs from the plan:** a site with a real robots.txt file is refused by the job in plain words, because only the plugin can tell; the preview still shows the exact lines to add by hand) | 11.02 |
| 11.06 | ✅ 2026-10-04 Plugin version bump: the new signed routes in PHP and `signRequest` mirrored; the wrong-site refusal still applies to every address; `npm run test:wordpress` on the oldest supported WordPress and the latest (Plugin 1.1.0: `POST /state`, `PUT`/`DELETE /robots`, meta emptied = forgotten, `features` in `/status`; an older plugin is `plugin_outdated`. `npm run test:wordpress` passes on the latest WordPress and on 6.2 with PHP 7.4) | 11.01 |
| 11.07 | ✅ 2026-10-04 Make the approve, apply and undo jobs and the repository functions handle each kind, with the fingerprint covering exactly what was shown (`approve`, `autofix.apply`, `autofix.undo`, `isLatestApplied` handle each kind; a write that fails part-way puts back what it wrote) | 11.02, 11.06 |
| 11.08 | ✅ 2026-10-04 The D3 screen shows a kind-specific preview (code, a before/after table, or the exact lines) and what was left out (The D3 page shows the code per page, a before and after table, or the exact lines, and what was left out; three new e2e pages with axe and 375/768/1280 sweeps) | 11.03–11.05 |
| 11.09 | ✅ 2026-10-04 Re-check mapping: each kind gets the readiness check that proves it (`C2`, `F3`, `A1`) through the existing `fix.verify`; a scan that could not look is "couldn't check" (Re-check: each kind goes through the existing `fix.verify` with its own readiness check (`C2`, `F3`, `A1`); no new code was needed) | 11.07 |
| 11.10 | ✅ 2026-10-04 Docs and copy: CLAUDE.md Auto-fix bullet, UI_DESIGN D3 row, the product pages' wording (CLAUDE.md, UI_DESIGN D3 and the ADR addendum are updated. The marketing pages do not promise auto-fix, so no copy changed) | 11.08 |

**Parallel:** 11.03, 11.04 and 11.05 once 11.02 lands. 11.06 can start right after 11.01.

**Definition of Done:**
- [x] Unit: each kind's proposal is deterministic and passes `jsonld.js` or its own validator; nothing is invented (a field the customer did not give is left out). (`src/core/autofix-fixes.test.js`; the robots lines are also run through our own robots.txt reader)
- [x] Integration: approve → apply → re-check → undo for each kind against the WordPress stand-in; undo restores the earlier value exactly. (`tests/integration/autofix-kinds.test.js`, beside `autofix-jobs.test.js`)
- [x] Contract: the plugin changes the real page on WordPress 6.2 / PHP 7.4 and the latest (`npm run test:wordpress`), and refuses a wrong-site address. (both runs pass, 16 tests each)
- [x] A changed fingerprint refuses the approval for every kind. (a scan that changed since the preview: `autofix-changed`, tested for robots.txt; the worker checks `payloadProblems` for all three)
- [x] Axe sweep and leak tests pass for the changed screens and new queries. (`tests/e2e/pages.js`, `tests/tenancy/repositories.test.js`)

## Milestone 12 — Entity checks and guidance (#7)

**Goal:** a customer sees which profiles describe the brand, whether the engines describe it correctly, and gets the exact text to put on each profile. We can fix what lives on their own site (Organization `sameAs`, the About page) and guide the rest. We do not write to Google's Knowledge Graph, and we say so.

**Pre-requisites:** Milestone 6. Task 12.06 needs Milestone 11.

| # | Task | Needs |
|---|---|---|
| 12.01 | ✅ 2026-10-04 🔒 Add an entity profile to the Brand Kit (a new schema version: legal name, founding year, profile links by platform, Wikidata ID if known). Every save stays an immutable version; competitors stay outside it (The Brand Kit's schema is version 2: an `entity` section (founding year, where it is based, profile links by platform, Wikidata item number); the legal name stays in `identity`; a version-1 kit reads with the section empty. Decided in [ADR-0013](adr/0013-entity-checks-and-guidance.md)) | — |
| 12.02 | ✅ 2026-10-04 Profile check: for each profile the customer typed, fetch it through the safe fetcher (robots obeyed, since it is not their domain) and report reachable, names the brand, links back to the domain. A platform that blocks us is "couldn't check", never "fail" (`src/crawler/profile.js` through the safe fetcher, robots.txt obeyed as `AEOCornerBot` even for a verified customer; judged in `src/core/entity-checks.js`. Findings: names the business, links back or not, not found, does not name it, and "couldn't check" for a firewall, a sign-in page, a page that needs JavaScript, robots.txt, a server error or a timeout. A real result is kept for 30 days over a later "couldn't check") | 12.01 |
| 12.03 | ✅ 2026-10-04 Wikidata presence check through its public API: found, not found or ambiguous. Add the host to `src/core/subprocessors.js`, or the subprocessor test fails (`src/integrations/wikidata.js` (`wbsearchentities`, `wbgetentities`, `wbgetclaims` for P856). Found only if exactly one item's official website is the customer's domain; a name match alone is ambiguous; a number the customer typed is confirmed or a mismatch. `www.wikidata.org` is in the subprocessor list) | 12.01 |
| 12.04 | ✅ 2026-10-04 Entity accuracy, in code, from answers we already read: for the brand-intent questions, compare the engines' stated facts (the `claims` rows) with the Brand Kit's. Each fact is right, wrong, or not mentioned; a wrong fact is the finding (`src/core/entity-accuracy.js`: the founding year, where it is based, and price amounts, compared with the brand's `claims` in brand-intent answers over 28 days. Right, wrong, not mentioned, or unknown when no answer was read. **Differs from the plan:** only these three facts are compared, because they are the ones a customer states precisely; free-form Brand Kit facts are not matched to claims) | 12.01 |
| 12.05 | ✅ 2026-10-04 New recommendation rules keyed `entity.<what>:<subject>` (a wrong fact, an unverified profile, no Wikidata item), with ICE priors in `recommendations.js`; none is raised when the check could not run (`entity.wrong_fact` (at least two wrong statements in the window), `entity.profile` (a profile we could read that does not name the business, or is gone) and `entity.wikidata` (no item, ambiguous, or a wrong number). An `error` check opens nothing and does not clear an open one. `reconcile` judges the entity rules one by one. Template narratives and the narrative eval cover all three) | 12.02–12.04 |
| 12.06 | ✅ 2026-10-04 Organization JSON-LD `sameAs`, `foundingDate` and `legalName` from the checked profiles and typed facts only, through the Milestone 11 machinery (`readiness.D3`) (`readiness.D3` is now an Auto-fix: the Organization node with the profiles that passed our check, the founding year and the legal name; its links are not typed on the screen, a typed link is ignored, and undo works like every home-page fix. Later Organization fixes keep what an earlier one wrote. `foundingDate` accepts a year. **Open:** a profile on a platform that always blocks us can never be confirmed, so it cannot be written by this fix (see the ADR)) | 11.07, 12.02 |
| 12.07 | ✅ 2026-10-04 Platform checklists for the profiles we can't touch (Google Business Profile, LinkedIn, Crunchbase, Wikidata, a trade directory): the steps and the exact text, filled in from the Brand Kit. We create no accounts and post nothing (`src/core/entity-guidance.js`: Google Business Profile, LinkedIn, Crunchbase, Wikidata and a trade directory, each with steps and copyable fields filled only from the Brand Kit; what is missing is listed with where to add it. Wikidata's checklist says when not to create an item. Limits checked 2026-10-04 against secondary sources) | 12.05 |
| 12.08 | ✅ 2026-10-04 About page from Content Studio (`readiness.D2`): a content type built from the Brand Kit's facts, through the existing research → plan → draft → check pipeline and the usual approval (`readiness.D2` makes an `about_page` item through the existing pipeline and approval (migration `0007` adds the format). Its headings are the questions a stranger asks; the typed year and place are facts a draft may state. `BRIEF_VERSION` is `b2`. Marked up as an Article. Not run against the live model) | — |
| 12.09 | ✅ 2026-10-04 The Entity screen `/projects/:pid/entity`: profile table, Wikidata status, engine accuracy per fact, next steps. Wireframe signed off first (`/projects/:pid/entity` (UI_DESIGN D7): profile table, Wikidata card, what engines say per fact, the checklists, "Check now". The wireframe in UI_DESIGN §5.4 is a proposal: the founder has not signed it off. Axe and 375/768/1280 sweeps cover it) | 12.02–12.05 |

**Parallel:** 12.02, 12.03 and 12.04 together after 12.01. 12.08 any time.

**Definition of Done:**
- [x] Unit: the accuracy comparison (right, wrong, missing) over fixture claims; a profile that errors is never "failed". (`src/core/entity-accuracy.test.js`, `entity-checks.test.js`, `entity-view.test.js`, `tests/integration/profile-check.test.js`)
- [x] Hostile-input test for each new page parser (a profile page is hostile input; linear time). (a deeply nested page, a megabyte word, thousands of links, and repetitive claim text; loose wall-clock bounds)
- [x] Integration: a wrong engine fact raises one recommendation, and the same condition never raises a second. (`tests/integration/entity-jobs.test.js`)
- [x] The `sameAs` fix includes only profiles that passed the check, and its undo works. (`src/core/autofix.test.js`, `tests/integration/autofix-jobs.test.js`, `tests/routes/project-actions.test.js`)
- [x] Subprocessor test passes with the new host. Axe sweep and leak tests pass. (`tests/routes/subprocessors.test.js`, `tests/e2e/pages.js` entries `entity`, `entity-viewer`, `entity-empty`, `tests/tenancy/repositories.test.js`)

## Milestone 13 — Citation opportunities (#9)

**Goal:** the Citations screen answers "which sources do engines trust on my questions, which of my own pages do they cite, and what should I make or get listed on?", and a citation fix is judged on citation share.

**Pre-requisites:** Milestone 6 (the Citations screen, citation gaps and the evidence pack already exist).

| # | Task | Needs |
|---|---|---|
| 13.01 | ✅ 2026-10-05 🔒 Source types in `src/core/citation-types.js` by rules and a reviewed list: own site, review or directory, forum, news, documentation or wiki, competitor, marketplace, other. An unrecognised site is "other", never guessed by a model (`src/core/citation-types.js`: own and competitor are decided per project, then a reviewed list of about a hundred well-known sites, then a rule for `docs.` / `help.` hosts. A listed name matches itself and its subdomains, never a longer name that ends in it. Decided in [ADR-0014](adr/0014-citation-opportunities.md)) | — |
| 13.02 | ✅ 2026-10-05 Own-page citations: which of the brand's pages are cited, how often and by which engine, from the `citations` rows (URLs reached only through the organization's own citation ids) (`dashboard.ownPageCitations`, one row per page and engine, merged by `ownPageRows`; `keyPages` and `uncitedKeyPages` name the key pages of the latest scan that were never cited, judged only when the site was cited at least 10 times; the home page is never named) | — |
| 13.03 | ✅ 2026-10-05 The format of each frequently cited page (list, comparison, review, guide, documentation), read once with the existing linear parsers and kept in the global URL dictionary (`src/core/citation-format.js` over `extractPage`; `src/crawler/cited-page.js` through the safe fetcher with robots.txt obeyed as `AEOCornerBot`; the job `citations.formats` reads ten pages a project a day, most cited first. **Differs from the plan:** the formats are list, comparison, review, guide, documentation, FAQ and other, and a page we could not read has *no* format (not "other"). Migration `0008` adds `web_urls.page_format` and the signals that make a page easy to cite) | 13.01 |
| 13.04 | ✅ 2026-10-05 Citation opportunities per question: the cited sources that did not name the brand, ranked by how often engines cite them and the share of answers they affect, each with its type and format (`rankOpportunities`: by site and by question, deterministic; the share is of the question's readable answers, and "Couldn't check" when it has none) | 13.01, 13.03 |
| 13.05 | ✅ 2026-10-05 New rules: `citation.gap:<domain>` and `citation.own_page_uncited:<url>`. Paths: a page in the format engines cite (Content Studio), or a "get listed" checklist with a copyable outreach note built from facts. We never send it (`citation.gap` replaces `visibility.cited_source`; on a competitor's site with pages in a format we write the path is Content Studio, anywhere else it is "get listed" with a note to copy (`buildOutreachNote`, and a test that every address, quotation and number in it is from the facts). `citation.own_page_uncited` is a content refresh. **Differs from the plan:** a path can change while the task is still open; one already started keeps its path) | 13.04 |
| 13.06 | ✅ 2026-10-05 Content Studio: a target format on the brief, the evidence pack's cited pages as the model to beat, and quality checks for what makes a page citable (a named author, dates, sources linked, original figures) (starting from a citation gap sets the item's format from the cited pages; the evidence pack prefers the format we read and lists "pages to beat" with what they have; `BRIEF_VERSION` is `b3`. **Differs from the plan:** the four citable checks (`citableChecks`) are advice shown on the item and are *not* in the 100-point score or in `ready`: a draft cannot name an author or a figure it was not given. Not run against the live model) | 13.03 |
| 13.07 | ✅ 2026-10-05 Outcome metric per rule family: a citation fix is measured on citation share, not mention rate, with the same significance test and windows. Needs a migration (`0008`) and a change to `outcomes.measure` (`recommendations.metric` and `action_outcomes.metric`; the baseline and after counts use `cell_results.citations_total` and `citations_own` of complete cells; proof cards, the shared page and the weekly email word a citation result as a share of cited sources) | 13.05 |
| 13.08 | ✅ 2026-10-05 Citations screen (C4) upgrade: type breakdown, trend, own-page table, an opportunities tab (three views at `?tab=overview|opportunities|pages`. The wireframe in UI_DESIGN §5.3 is a proposal: the founder has not signed it off. Axe and 375/768/1280 sweeps cover all three) | 13.02, 13.04 |

**Parallel:** 13.01 and 13.02 start together; 13.06 and 13.07 run beside 13.08.

**Definition of Done:**
- [x] Unit: source types over fixture sites; an unknown site is "other"; opportunity ranking is deterministic. (`src/core/citation-types.test.js`, `citation-opportunities.test.js`, `citation-rules.test.js`)
- [x] Hostile-input test for the format reader. (`citation-format.test.js`: 100,000 nested levels, a megabyte word, thousands of links and headings, a title of repeated trigger words; `tests/integration/cited-page.test.js` over real sockets)
- [x] Integration: a citation fix is measured on citation share and judged by the same test as before; a mention-rate fix is unchanged. (`tests/integration/citation-opportunities.test.js`)
- [x] Nothing in an outreach note is a fact that is not in the evidence. (`findUnsupportedInNote`; the note carries no number of its own)
- [x] Axe sweep and leak tests pass. (`tests/e2e/pages.js` entries `project-citations-opportunities` and `project-citations-pages`; `tests/tenancy/repositories.test.js`)

## Milestone 14 — Visibility recovery cases (#11)

**Goal:** when visibility drops and stays down, AEO Corner opens a case, says what probably caused it and what the evidence is, proposes repairs through the existing Action Center, and closes the case with proof that it recovered. When the evidence is thin it says "we can't tell", not a guess.

**Pre-requisites:** Milestone 8 (alerts), Milestone 11 (to check that earlier fixes are still on the site).

| # | Task | Needs |
|---|---|---|
| 14.01 | 🔒 `recovery_cases` table (org and project owned, the triggering change event, engine scope, metric, opened, status `diagnosing → repairing → recovered | closed_noise | closed_unknown`) and `recovery_events`. Migration `0009`, composite FK to projects | — |
| 14.02 | 👤 The persistence rule (F4) in pure code (`src/core/recovery.js`): a decline is lasting only if it passed the significance test and is still lower over the latest days. A one-run dip opens nothing. Test with replayed fixture histories | — |
| 14.03 | The diagnosis engine in `src/core`: candidate causes, each with evidence and a confidence band. Candidates: a site change (`site_changes`), a readiness regression between scans, an earlier fix no longer on the page, an engine-wide move, a competitor's gain, a lost citation, an engine that stopped showing an answer. Fewer than two supporting facts means "can't tell" | 14.02 |
| 14.04 | Immediate re-checks when a case opens: a fresh scan, and each earlier fix's live check (a theme or plugin update can remove injected markup). Reuses `fix.verify` and `live-check.js`; "couldn't look" is its own result | 11.07 |
| 14.05 | Recovery recommendations: each diagnosis links to an existing rule so the repair is an ordinary action. "SEO-safe" rule: a repair never blocks crawlers, removes `noindex` handling or changes a canonical without a person's approval | 14.03 |
| 14.06 | Close the case in the system's own words: `recovered` only when the metric is back inside its earlier range by the same test, `closed_noise` when it recovers by itself, `closed_unknown` after a set time. Proof card "Recovered" | 14.01, 14.03 |
| 14.07 | Recovery screen `/projects/:pid/recovery` and the case page: a timeline of what changed and when, the diagnosis with its evidence, the repairs in progress. Wireframe signed off first | 14.03, 14.06 |
| 14.08 | Alert "a decline has lasted" (plan-gated like the other alerts, once per case, a claim told once) and a digest line | 14.01 |
| 14.09 | Eval: replayed declines with a known cause; the engine must name it or say "can't tell", and must never name a cause the evidence does not support | 14.03 |

**Parallel:** 14.02 beside 14.01. 14.04, 14.05 and 14.08 beside 14.07 once 14.03 lands.

**Definition of Done:**
- [x] Unit: the persistence rule on noisy and genuinely falling series; the diagnosis with each cause and with none. (`src/core/recovery.test.js`)
- [x] Eval: no diagnosis states a cause missing from its evidence. (`src/core/recovery.eval.test.js`)
- [x] Integration: a decline opens exactly one case however many times the refresh runs; recovery closes it once. (`tests/integration/recovery-jobs.test.js`)
- [x] A day an engine did not finish is never counted as the customer's decline (same rule as `trends.js`). (unit and integration tests)
- [x] Axe sweep and leak tests pass for the new screens and queries. (`tests/e2e/pages.js` entries `recovery*`; `tests/tenancy/repositories.test.js`)

## Milestone 15 — Autopilot (#6)

**Goal:** each week AEO Corner prepares the next fixes and drafts by itself, and the customer reviews them in one place. It does not publish content or change a site without a person's approval, unless the founder chooses option B in 15.01.

**Pre-requisites:** Milestones 11, 13 and 14; Milestone 8's billing, quota and spend caps; the draft and "check now" allowances.

| # | Task | Needs |
|---|---|---|
| 15.01 | 👤🔒 Decide F1 (prepare only, or standing approval for low-risk JSON-LD) and write ADR-0013. This task sets the size of the rest | — |
| 15.02 | Autopilot settings per project (`autopilot_settings`: on or off, which kinds it may prepare, a weekly draft budget). Owner and admin only, off by default. Migration `0010` | 15.01 |
| 15.03 | `autopilot.tick` (queue `content`, after each weekly refresh): take the top open recommendations that have a path, prepare an Auto-fix proposal (status `proposed`, nothing written to the site) or run a content draft up to its quality check. Respects the draft allowance, spend caps, a connected WordPress, and a daily limit | 15.02 |
| 15.04 | A "Ready for you" inbox `/projects/:pid/autopilot`: each item shows exactly what was prepared, with approve, edit or reject (a reason is kept and used to recalibrate ICE). Each approval carries its fingerprint or pinned revision | 15.03 |
| 15.05 | Digest and notifier kind: "3 changes are ready for your approval", linking to the inbox. The link needs sign-in; nothing is approved from an email | 15.03 |
| 15.06 | Safety: a project-level pause, a kill switch for staff, a flag `autopilot`, audit entries in `recommendation_events`, and a view in the staff console | 15.03 |
| 15.07 | Only if F1 = B: standing approvals for JSON-LD kinds on a verified domain, with a daily cap, a record of who set the policy, and automatic undo of our own change when its re-check fails. Content is never published this way | 15.01, 15.06 |
| 15.08 | Evals and tests: no content is ever published without a person; no site change without a matching fingerprint; budgets and caps are kept; the same state always prepares the same items | 15.03–15.07 |
| 15.09 | Copy review: "agentic" wording on the marketing pages says exactly what Autopilot does | 15.08 |

**Definition of Done:**
- [ ] Integration: a weekly tick prepares items, spends only inside the allowance, and a second tick for the same week prepares nothing more.
- [ ] A rejected item is not prepared again without new evidence.
- [ ] Under option A, nothing reaches the customer's site or `published` state without a person's approval (tested at the repository, not only the route).
- [ ] Spend cap and pause stop the tick at once; the kill switch is audited.
- [ ] Axe sweep and leak tests pass.

## Milestone 16 — Claude as a fifth engine (#5)

**Goal:** a project can track whether Claude names the brand, shown beside the other four engines with the same "couldn't check" rules.

**Pre-requisites:** the founder's decision F2. Anthropic is already a vendor (extraction), so the subprocessor list likely needs no new row, but the test decides.

| # | Task | Needs |
|---|---|---|
| 16.01 | 👤🔒 Decide F2 (with web search, or the model alone), the plans that include it (F3), and write an addendum to ADR-0006 | — |
| 16.02 | Add `claude` to the engine list: `ENGINES` in `src/engines/contract.js`, the `engines` seed, and every engine ENUM column. ENUM values are appended at the end; do this before the fact tables grow. Migration `0011` on dev and test, then `prisma generate` | 16.01 |
| 16.03 | The adapter behind the contract: `submit`, `poll`, `normalize`, `estimateCostMicros`, with web-search results turned into citations. "No answer" only when Claude says so; a reply we can't read is `bad_response`. Goes through `callProvider` as provider `anthropic`. Errors carry no body or URL | 16.02 |
| 16.04 | Fixtures: hand-built ones for the error cases, and one recorded real answer through `npm run engines:try -- --engine claude --record` (a paid call, reviewed before it becomes a fixture). A "changed shape throws" test | 16.03 |
| 16.05 | Project opt-in (F5): not added to existing projects automatically; offered once; new projects follow the plan. The `projectEngines` and entitlement rules decide how many engines a plan may track | 16.02 |
| 16.06 | Screens: the engine filter, matrix column, per-engine cards, compare, citations and digest all list five engines, and a project without Claude says "Not tracked", never 0 | 16.03 |
| 16.07 | Cost: update `src/core/unit-cost.js`, run `npm run cost:report` on a real run, and tell the founder the cost per prompt-run with five engines | 16.03 |
| 16.08 | Keep it out of the free audit: the audit's $0.75 budget stays on four engines unless the founder says otherwise | 16.01 |

**Definition of Done:**
- [ ] Contract: the Claude adapter passes the same contract tests as the other four.
- [ ] A failed or unread Claude answer is "couldn't check" everywhere it is shown, and never lowers a rate.
- [ ] A project with four engines is unchanged after the migration.
- [ ] Cost per prompt-run is measured and reported. Axe sweep and leak tests pass.

## 5. Risks

| Risk | Consequence | What we do |
|---|---|---|
| Cost per prompt-run is already above the $0.12 target; a fifth engine and more drafts add to it | Margin falls faster than revenue | Measure first (16.07), gate by plan (F3), keep Claude out of the free audit |
| Widening Auto-fix changes real customer sites | A bad change costs trust | Same approval, fingerprint, undo and re-check for every kind; plugin contract-tested on real WordPress; no kind ships without a working undo |
| Autopilot looks like it publishes by itself | Customers and press read "agentic" as "uncontrolled" | Prepare-only by default (F1), explicit copy, an audit trail |
| Diagnoses that sound sure | A wrong cause sends a customer in the wrong direction | Evidence for every cause, "can't tell" below two facts, an eval (14.09) |
| Third-party profile pages block our fetch | Entity checks look broken | "Couldn't check" is its own state; guidance still works |
| New ENUM values on large fact tables | A slow migration later | Add the Claude engine (16.02) while tables are small, or choose a lookup-table design first |

## 6. After each milestone

- Tick the boxes here and add a one-line pointer in [MILESTONES.md](MILESTONES.md).
- Update the CLAUDE.md section for what changed and the affected UI_DESIGN rows, in the same pass.
- A one-way-door decision (15.01, 16.01) gets its ADR before code.
- Run the suites that apply: `npm test`, `test:routes`, `test:integration`, `test:tenancy`, `test:e2e`, and `test:wordpress` for Milestones 11 and 12, `test:adapters` for 16, `test:security` for 11 and 15.

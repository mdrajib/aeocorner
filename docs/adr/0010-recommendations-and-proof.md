# ADR-0010: Recommendations and proof: stable keys, a lifecycle only the system can finish, and words that cannot claim more than the evidence

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-04 |
| **Context of discovery** | [MILESTONES.md Milestone 6](../MILESTONES.md#milestone-6--action-center--proof), tasks 6.01 (rules engine) and 6.05 (lifecycle), both marked one-way doors. [CUSTOMER_JOURNEY §7](../CUSTOMER_JOURNEY.md) changes 2 and 3. |

## Context

The Action Center is where the product's promise (Measure, Diagnose, Fix, Prove) is either kept or faked. Three things are hard to change once customers have history in them: how an issue is identified (so it is never listed twice, and a result stays attached to the right fix), who is allowed to say a fix worked, and what the words on a recommendation may claim.

## Decision

**1. An issue has a stable key, and the rules engine is pure.** A recommendation is `rule_code:subject` (`readiness.A1:a1`, `visibility.lost_prompt:<question id>`, `visibility.cited_source:reddit.com`). `recommendations.open_key` is that key while the recommendation is live and NULL once it ends, with a unique index on `(project_id, open_key)`: the database refuses a second live row for the same issue, so two refreshes at the same moment make one. The engine (`src/core/recommendations.js`) is deterministic: findings in, candidates out. A check that could not run (`error`) and one that does not apply are never issues, and a question counts as lost only on complete cells (a half-collected one that names the brand vetoes it). Issues left out by a cap are still "detected", so they are never mistaken for fixed ones.

**2. The lifecycle has one table, and a person cannot finish it.** `src/core/recommendation-lifecycle.js` lists every allowed move and who may make it. People start, stop, dismiss, mark done, confirm an unverified fix or say "fix it again". Only the system verifies a fix, starts measuring after a pass, and records a verdict. The repository writes a status only if the row still has the status it was read with, and records every move in `recommendation_events`.

**3. Marking done saves the baseline, then the site is looked at again.** The baseline (readable answers and how many named the brand, over the 28 days to that moment, for the questions the fix targets) is stored on the recommendation and never recomputed, and after "done" a refresh no longer changes the fix's scope. A readiness fix is re-checked by scanning the site again and reading its own check: at once, after an hour, after a day (CDNs cache). A pass verifies; three failures leave it `unverified`, where the customer can confirm or redo it. "We could not look" is its own reason and is never described as a failing fix. A fix no machine can check (a new page, a profile on another site) goes straight to measuring: marking it done was the confirmation.

**4. Proof uses the product's one significance test.** At +2 and +4 weeks the same questions are counted after the fix (runs queued after measuring began, complete cells only) and compared with the baseline by `compareWindows` (p < 0.05, at least 5 points, at least 20 answers each side). Verdicts: `proven_win`, `declined`, `no_change`, `insufficient_data`. +2 weeks can only close a recommendation by a win or a decline; the rest wait for +4 weeks. `insufficient_data` is never shown as "no change". A declined fix whose problem is still present is raised again at once as its follow-up; a dismissed one stays quiet for 90 days (30 if "already done"), a win or "no change" for 28.

**5. Words are built from facts and checked.** Every recommendation is stored with a template narrative made from a closed set of facts the evidence supports (`src/core/narrative.js`), so none is ever without a why and steps, and it costs nothing. Claude may rewrite it (`recommendations.narrate`, `src/llm/narrative.js`), but a reply is stored only if every number, site name, quoted phrase and proper name in it is in the facts (or, for the steps, the fixed advice). Otherwise it is thrown away and the template stays. `npm run eval:narrative` runs the check over a corpus of 58 recommendations and 7 made-up narratives it must catch.

**6. Confidence learns, slowly.** A rule's confidence is a prior (a number we chose) mixed with how its fixes actually turned out across all projects, counting the prior as 10 observations (`calibratedConfidence`). The cross-organization lookup behind it returns counts only.

### Addendum 2026-10-04: sharing a proven win

A proven win's card has a Share button (UI_DESIGN D4; [CUSTOMER_JOURNEY](../CUSTOMER_JOURNEY.md) day 30: the customer shows the result to a boss or a client). It makes a public, read-only page at `/p/:publicId`. What was decided:

| Decision | Why |
|---|---|
| **Only a proven win over all engines can be shared**, and the repository enforces it, not just the screen | A shared page is the customer vouching for us to a third party. A "within normal variation" or a decline is never presented as a result outside the company |
| **The address is the secret** (a ULID), one row per outcome. Stopping sets `revoked_at`; sharing again makes a **new** address | A link someone kept after a stop must stay dead. Double clicks keep one link, so a link just copied is never broken |
| **The page shows only the brand, its domain, the recommendation's title and the counts and test result.** It is built from the outcome and never receives a question, an answer or a competitor. Before sharing, the screen says what the page shows and what it never shows | A recommendation's title is the one free-text field; the person sees that it is included. Nothing about the organization or its people is read |
| **Public lookups are one reviewed function** (`system.proofShares.byPublicId`); unknown, malformed, stopped, closed-organization and archived-project addresses are the same 404 | No page may confirm that something exists behind a guess |
| **`Cache-Control: no-store`, no referrer, noindex, no analytics, `/p/` disallowed in robots.txt** | Stopping a share must work at once; the address must not leak through a referrer or a search index |
| `site.approve` (owner, admin, editor) may share and stop | Putting words on the public internet is as big a step as publishing a page |

Not built: an image card to download, and a "viewed" count. The page does not record who opened it.

## Consequences

- Nothing in the Action Center can be marked a win without the numbers: not by a person, not by a template.
- The lopsided cost is the baseline. A project with fewer than 20 readable answers for the targeted questions gets "not enough data" at both checks. That is honest and will be common for one-question fixes on small projects; the answer is more questions or samples, not a weaker test.
- The prior numbers (impact weights, effort, per-rule confidence) are v0 guesses, like the readiness rubric. They are recalibrated from the outcomes this milestone starts collecting.
- Auto-fix and Content Studio buttons arrive in Milestone 7; until then every fix path ends in "follow the steps, mark it done", and verification of a published page (a live-URL check) is added then.
- The model-written narrative has not run against the live model yet. Its first run, and `npm run eval:narrative -- --live`, are its first check.

# ADR-0015: Visibility recovery cases: a decline is lasting only if it is still down, a cause is named only on two facts, and only the system opens, diagnoses and closes a case

| | |
|---|---|
| **Status** | Accepted (the persistence defaults are the founder's decision F4, provisional until the founder picks the days) |
| **Date** | 2026-10-05 |
| **Context of discovery** | [MILESTONES_SERVICES.md Milestone 14](../MILESTONES_SERVICES.md#milestone-14--visibility-recovery-cases-11), tasks 14.01 to 14.09. [ADR-0010](0010-recommendations-and-proof.md) (re-checks, outcomes), [ADR-0011](0011-content-studio-and-wordpress.md) (auto-fix and undo), [ADR-0012](0012-billing-traffic-notifications-and-the-console.md) (alerts and the notifier) |

## Context

Change detection already says when a figure fell significantly (28 days against the 28 before), and the weekly alert tells the customer. It stops there. A customer who gets "you fell 24 points" has no way to know whether it is a bad fortnight or a change on their site, what probably caused it, what to do, or when it is over. The dangerous failure is a diagnosis that sounds sure and is wrong: it sends someone to repair the wrong thing.

## Decision

**1. A decline is "lasting" by a rule in code, with defaults until the founder decides F4** (`src/core/recovery.js`, `RECOVERY`). It passed the 28-vs-28 significance test **and** the latest 14 days (at least 10 answers) are still at least 5 points below the earlier range. A significant fall that has already come back is `noise` and opens nothing; one with too few recent answers is `pending`, never "no decline". A fall on one engine counts like a fall on all of them (`oneEngineCounts`). Days an engine did not finish are left out of the windows exactly as in `trends.js`, so an outage of ours is never the customer's decline. Three metrics can open a case: how often the brand is named, share of voice and citation share.

**2. A decline opens exactly one case.** `recovery_cases.open_key` (`metric:engine`) is set only while the case is open and is unique per project, with a CHECK that ties it to `status`. A job that runs twice, or two at once, finds the case already there. A decline on one engine is folded into the all-engines case of the same metric, and share of voice into mention rate for the same scope (same counts, different clothes); citation share stays separate. After a case closes, the same decline cannot open another for 14 days, so a wobble is not a second case.

**3. A cause is named only on two supporting facts that outnumber the facts against it; otherwise the answer is "we can't tell".** Seven candidate causes (a change we made to the site, a readiness check that stopped passing, an earlier fix that is gone, lost citations, a competitor's gain, an engine that stopped showing an answer, an engine-wide move), each a function from numbers we hold to facts written as sentences by code. No model writes any of it. The band is `strong` with three facts and none against, `likely` otherwise. "We can't tell" is a result with its own words on the screen, and the timeline records it. The eval (`recovery.eval.test.js`) replays planted causes, histories with no cause and 150 random inputs, and fails if a named cause points at anything that was not in the input.

**4. Re-checks first, and "couldn't look" is its own state.** When a case opens, `recovery.recheck` (queue `crawl`) scans the site again and looks at each earlier fix: a fix with a readiness check is judged by that check in the fresh scan, a published page is fetched and read as a crawler would. A fix we could not look at is `unknown`, never `gone`, and supports no cause.

**5. A repair is a pointer to something that already exists.** An undo of our own change, a fix to do again, or the open recommendations of the matching rules. Nothing here writes to a site: the person approves it in the Action Center as always. A repair is never a change that blocks crawlers, removes `noindex` handling or changes a canonical (`FORBIDDEN_REPAIRS`, `seoSafe`); the screen says so.

**6. Only the system moves a case, and the closing is by the same test.** `canMoveCase` is the one table. `recovered` needs the latest 14 days back inside the earlier range (not significantly lower, and within 5 points) and a linked repair done since the case opened; the same recovery with nothing done is `closed_noise` ("recovered by itself", which the page does not call a fix); a case still down after 56 days is `closed_unknown`. A recent window with too few answers decides nothing. There is no button to close or reopen a case.

**7. Telling the customer.** The "decline has lasted" alert is told once per case through the notifier, under the plan's `alerts` feature and the same switch as the other alerts; it replaces the plain drop alert about the same measure. If someone's one-proactive-email-a-day limit holds it back, the case stays untold and is tried again the next day (for two weeks) rather than being lost. The weekly digest names an open case until it ends and a recovery in the week it happens.

## Consequences

- The screen shows the numbers the case was opened on, never a rate with nothing behind it, and every cause lists its facts so the customer can check them.
- The defaults in (1) are a guess about what feels like "lasting". They are constants in one place, with tests, so the founder's F4 answer is a one-line change.
- `readiness_regression` and `site_change` need two scans around the fall. A project that is only a few weeks old has one, and is told "we can't tell" rather than something invented.
- A case costs a scan and a few fetches (free, no provider call). The model is not involved anywhere, so there is nothing to eval against a live model.
- Not built: recovery cases are not shareable as a public proof page, and the diagnosis does not yet read competitor pages or engine release notes.

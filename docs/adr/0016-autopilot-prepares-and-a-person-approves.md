# ADR-0016: Autopilot prepares and a person approves: nothing reaches a customer's site or `published` without a click from a person

| | |
|---|---|
| **Status** | Accepted (option A of founder decision F1, provisional until the founder answers; option B is not built) |
| **Date** | 2026-10-05 |
| **Context of discovery** | [MILESTONES_SERVICES.md Milestone 15](../MILESTONES_SERVICES.md#milestone-15--autopilot-6), tasks 15.01 to 15.09. [ADR-0010](0010-recommendations-and-proof.md) (lifecycle, who moves a recommendation), [ADR-0011](0011-content-studio-and-wordpress.md) (approval pins what was shown), [ADR-0012](0012-billing-traffic-notifications-and-the-console.md) (allowances, spend caps, flags, the notifier) |

The plan called this "ADR-0013"; that number was taken by the entity checks, so it is 0016.

## Context

Every week the Action Center lists what to do next, and each customer must open each item, start it, preview it and approve it. Autopilot is the wish that this work is done before they arrive. "Agentic" has two readings: *the product prepares things for me* and *the product changes my site by itself*. The second is the one that costs a customer their trust the first time it is wrong, and it breaks the rule every earlier milestone kept: **a person approves a change to a site, and approval pins what was shown.**

## Decision

**1. Option A: Autopilot prepares; a person approves.** It never writes to a customer's site and never moves a content item to `published`. It does only what a person could have done by pressing the buttons that already exist, up to (and never including) the approval:

- for a fix the plugin can write (`AUTOFIX_RULES`): it works out the exact change and stores what it would write and its fingerprint. Nothing is sent to the plugin.
- for a fix that is a page: it starts a Content Studio item and lets the pipeline run to the quality check. The item stays `ready` for a person to read, edit and approve; publishing stays a separate approval.

Option B (a standing approval for low-risk structured data on a verified domain) is **not built.** Task 15.07 stays open until the founder chooses it; if they do, it needs its own ADR, because it is the first time a change would reach a site without a person looking at it.

**2. The approval is the existing approval, with the same pin.** The inbox shows the item, and "Approve" posts to the Action Center's own approve route (`/actions/:rid/autofix/approve`, `/content/:cid/approve`) carrying the fingerprint or the revision that was shown. If what we would write now differs from what was prepared, the route refuses and shows it again. Nothing in Autopilot can approve; `approve` needs a person at the repository, as before.

**3. Only the system prepares, only a person decides.** An Autopilot item (`autopilot_items`) is `ready` → `approved` or `rejected` (by a person) or `withdrawn` (by the system: the fix is no longer needed, the recommendation was dismissed or done another way, or what was prepared no longer matches). A rejection keeps a reason. Nothing is prepared again for the same recommendation on the same basis, so a rejected item does not come back next week; it comes back only with new evidence (a different set of affected pages, or a re-raised recommendation). Rejections lower the confidence of that rule a little (`rejectionAdjustedConfidence`), the way a dismissed fix does.

**4. It is off by default and the limits are the customer's and ours.**
- Settings are per project, set by an owner or admin (`autopilot.manage`): on or off, the kinds it may prepare, a weekly draft budget, and a project-level pause.
- A plan feature (`autopilot`, on Growth and Agency: founder decision F3's suggestion) gates it. A project on a plan without it is shown what it would do and a way to upgrade, and nothing runs.
- It spends from the same allowance as a person: a draft takes a unit of the month's draft allowance when the item is made, and nothing starts when the allowance is gone, the organization's daily spend cap has paused collection, or no WordPress is connected for a fix that needs one. A weekly limit and a daily limit cap what one project can have waiting.
- The flag `autopilot` is the staff kill switch: off for everyone or for one organization, audited like every flag. The staff console lists what Autopilot prepared across organizations (read-only).

**5. Same state, same items.** The tick is deterministic: the recommendations that qualify are ranked by ICE then by ID, and an item's identity is `(project, recommendation, basis)`, so a second tick for the same week finds the items already there and prepares nothing more, and a crash and retry changes nothing.

**6. Telling the customer.** The weekly digest says "N changes are ready for your approval" and links to the inbox. The link needs a sign-in; no email has a button that approves. There is no separate Autopilot email: a person gets at most one proactive email a day, and the digest is that email.

## Consequences

- A customer who wanted "it just does it" does not get it, and the product says so plainly. What they get is the work done up to the last click, which is the part that cost them time.
- Every approval is the same code path as before, so undo, the fingerprint, the same-day re-check and the outcome measurement apply to an Autopilot item without a line of new logic.
- The inbox can show a "ready" item that a person already did by hand in the Action Center. The tick and the page settle it (`withdrawn` or `approved`) from what the recommendation and the change say now, never from the click.
- A draft prepared and never opened has cost real money. The budget, the allowance and the "no more than N waiting" limit bound that; a ready item left a month is withdrawn and its unit is not returned (the work was done).
- Not built: option B, per-kind standing approvals, a separate email, and publishing of any kind.

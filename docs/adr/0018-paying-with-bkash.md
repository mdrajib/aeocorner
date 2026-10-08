# ADR-0018: Paying with bKash: one month at a time, in taka, and nothing is believed until bKash is asked

| | |
|---|---|
| **Status** | Accepted (the four choices below were made by the founder on 2026-10-08) |
| **Date** | 2026-10-08 |
| **Context of discovery** | The founder wants customers in Bangladesh to pay with bKash, and to use it instead of Stripe for now. [ADR-0012](0012-billing-traffic-notifications-and-the-console.md) (billing: Stripe is the truth, plans enforced when there is a way to pay), [RUNBOOK_PROVISIONING.md](../RUNBOOK_PROVISIONING.md) |

## Context

Stripe gives us a subscription engine: it holds the card, charges every month, retries a failed charge and tells us by webhook. **bKash has none of that.** bKash is a wallet. A customer approves each payment in the bKash app on bKash's own page, and bKash takes taka only. Nothing renews by itself, and no webhook tells us a month has passed. So the billing cycle (when a month starts, when it ends, what happens when nobody pays) has to be ours.

## Decision

**1. One month at a time, paid on bKash's page.** The customer chooses a plan and presses "Pay with bKash". We ask bKash for a payment (tokenized checkout, a plain payment with no saved agreement), send the customer to `bkashURL`, and bKash sends them back to `/app/o/:org/billing/bkash/return`. We never see their bKash number or PIN. A saved agreement with automatic monthly charges was the other option; it needs bKash to switch on recurring charges for the merchant account and the documentation does not say whether the customer must still approve each charge, so it is **not built**. It can be added later behind the same `bkash_payments` table.

**2. Nothing is believed until bKash is asked.** The query string on the return trip (`paymentID`, `status`) is only used to find our own payment row, and only among that organization's rows. Money moved only if `execute` answers `Completed`, and only if the amount, the currency (`BDT`) and our invoice number in that answer equal what we stored (`bkash.settle`). A mismatch marks the payment failed and settles nothing. A forged "success" for a payment nobody approved makes `execute` refuse, and the payment is marked failed.

**3. Settling is one function and safe to repeat.** `system.billing.bkash.settle` locks the organization, marks the payment completed once (a status change that names the old status), works the period out from the subscription as it is at that moment (so two payments never overlap), then updates the subscription through the same `subscriptions.apply` Stripe uses. `bkash_payments.applied_at` records that the second step finished; the hourly sweep finishes any that did not. A payment that completes after we had given up on it (`expired`) still counts: the money was taken.

**4. A bKash subscription is a row in `subscriptions`** (`provider = 'bkash'`, key `bkash-<organization public id>` in the column that holds Stripe's ID). So the plan, the status, the grace period, the money-back window, the access levels and the retention window all work unchanged. Stripe's daily reconcile and the trial-ending email only look at `provider = 'stripe'`.

**5. The cycle, which bKash does not keep for us** (`src/core/bkash-billing.js`, pure and tested):

| When | What happens |
|---|---|
| Customer starts a trial | A `trialing` subscription for 14 days. No payment, no call to bKash. Once per organization, as with Stripe. |
| 5 days before the trial or paid month ends | One email per owner ("pay with bKash to continue"), from the billing address. Not sent once the customer chose "Stop renewing". |
| Customer pays | Active for one month. Paying early starts the new month when the paid one ends (nothing is lost); paying during the trial starts it when the trial ends. |
| Period ends unpaid | `past_due`: a seven-day grace with full access, then tracking pauses (data kept, as after a failed Stripe payment). |
| Unpaid for the grace week plus 30 days | Cancelled, which opens the read-only window and then the retention clock of ADR-0012. |
| Customer chose "Stop renewing" | At the period's end the subscription is cancelled instead of going past due. Paying again resets this. |
| Bigger plan mid-month | Starts now; the unused part of the paid month is taken off the price (whole taka, in the customer's favour). |
| Smaller plan mid-month | Not until the last 7 days of the month; it then starts when the paid month ends. We never refund the rest of a month. |

**6. Prices are fixed in taka** (`plans.price_bdt_month`, `NULL` = not open for bKash), not converted from dollars. The founder sets them; until then a plan shows "Not open yet". Add-ons (extra questions, extra drafts) are **not offered** with bKash: they are Stripe line items. The money-back promise (30 days from the first payment) is kept by hand: staff refund through bKash's merchant portal; there is no refund call in the app.

**7. Stripe stays.** Both can be configured. When the BKASH keys are set the plan screen takes payment through bKash; Stripe's routes, webhook, reconcile and tests are untouched and keep serving a Stripe customer. Plans are enforced when either is configured.

**8. The sweep is the safety net** (`billing.bkash_sweep`, hourly, queue `system`): finish unapplied payments; look up payments that were created more than ten minutes ago and never came back (a closed tab) at bKash and settle the completed ones; give up on a payment page after 24 hours; let time lapse unpaid subscriptions. The lapse and the retry need no bKash credentials.

## Consequences

- **Nothing here has run against bKash.** The client follows bKash's tokenized checkout API (`/tokenized/checkout/token/grant`, `/refresh`, `/create`, `/execute`, `/payment/status`, version `v1.2.0-beta`) as documented; the stand-in in `tests/helpers/bkash-stub.js` is built from the same description. The endpoint paths, the headers (`Authorization: <id_token>`, `X-APP-Key`), the `mode` value (`0011`, a payment without an agreement), the error code for "already completed" (`2062`) and the callback's `status` values (`success`, `failure`, `cancel`) must be checked in bKash's sandbox before the first real payment. That needs the founder's merchant credentials.
- A customer must come back to pay every month. That is a real drop in retention against automatic card billing; the reminder email and the grace week are the mitigation.
- bKash takes a transaction fee and settles in taka; the unit economics in [MVP.md](../MVP.md) are in dollars and have not been re-run for taka prices.
- `bkash_payments` records every amount charged. It is deleted with the organization by the purge like any other tenant table; if the founder needs financial records kept for tax, add it to `KEPT_AFTER_PURGE` in `src/core/org-purge.js`.
- The public pricing page follows the configuration (updated 2026-10-08): with the BKASH keys set it shows taka prices, no add-ons, a "How do I pay with bKash?" answer and bKash trial and refund wording, and the Product markup offers only plans that have a taka price (`pricingView(rows, { currency: 'bdt' })`). Without them it is unchanged, in dollars. The wording is a draft until the founder signs off the copy.

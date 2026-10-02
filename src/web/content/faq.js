// Home-page FAQ. One source for the visible accordion and the FAQPage JSON-LD, so they can't drift.
// Claims here must match what the product actually does (docs/MVP.md §5 F1, CUSTOMER_JOURNEY.md).
export const homeFaq = [
  {
    q: 'Is the audit really free?',
    a: 'Yes. The audit needs no account and no credit card. You confirm a work email with a 6-digit code so we can send you the permanent link to your report.',
  },
  {
    q: 'Which AI engines do you check?',
    a: 'ChatGPT, Perplexity, Gemini and Google AI Overviews. We use licensed data providers and official APIs to collect the answers, and the report shows how each answer was collected.',
  },
  {
    q: 'Why does the audit ask each question once?',
    a: 'AI answers change from one ask to the next, so a single answer is only a snapshot, and the report says so. Ongoing tracking asks every question three times and reports rates with a margin of error instead of a single yes or no.',
  },
  {
    q: 'What if you can’t check an engine?',
    a: 'We tell you. If an engine fails to answer, the report shows “Couldn’t check” for it. We never count a failed check as “not mentioned”, because that would blame your brand for our outage.',
  },
  {
    q: 'Will you change my website?',
    a: 'No. The audit only reads your public pages. When you use AEO Corner to fix things, you see the exact change first and nothing goes live on your site until you approve it.',
  },
  {
    q: 'What do you do with my email?',
    a: 'We use it to send your audit report. We only send marketing email if you tick the separate consent box.',
  },
];

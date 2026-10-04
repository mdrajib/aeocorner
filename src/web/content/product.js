// Copy for the product pages (one per stage of Measure → Diagnose → Fix → Prove) and the agency page.
// Milestone 9, tasks 9.02 and 9.03. DRAFT until the founder signs off (task 9.12).
//
// Every claim here must match what the product does today: docs/MVP.md §5, docs/CUSTOMER_JOURNEY.md and the screens in
// src/web/routes/. Where something is not built, it is not promised (no daily tracking, no auto-fix of other people's
// sites, no PDF or white-label reports). One source feeds the visible FAQ and the FAQPage JSON-LD, so they cannot drift.

export const stages = [
  {
    slug: 'measure',
    step: 1,
    name: 'Measure',
    icon: 'chart',
    title: 'Measure your AI visibility: AEO Corner',
    description:
      'See how often ChatGPT, Perplexity, Gemini and Google AI Overviews mention, recommend and cite your brand, with rates and a margin of error, not one lucky answer.',
    h1: 'See how often AI mentions, recommends and cites your brand',
    lead: 'We ask four AI answer engines the questions your buyers ask, several times each, and report what they actually said, compared with your competitors.',
    sections: [
      {
        heading: 'What you can see',
        intro: 'Four figures tell you where you stand, and each one opens the answers behind it.',
        items: [
          [
            'Mention rate',
            'The share of answers that name your brand, per question and per engine.',
          ],
          [
            'Share of voice',
            'Your mentions against everyone you track, so you know who AI names instead of you.',
          ],
          [
            'Recommendation and position',
            'Whether you are recommended, and where you sit when an answer is a list.',
          ],
          [
            'Citations',
            'Which sites AI cites, how often yours is one of them, and the sites that are cited when you are not.',
          ],
        ],
      },
      {
        heading: 'Why you can trust it',
        intro: 'AI answers are noisy, so we are careful about what we claim from them.',
        items: [
          [
            'Several samples, not one',
            'AI answers change from one ask to the next. Every question is asked three times per engine and reported as a rate.',
          ],
          [
            'Normal ups and downs are labelled',
            'A change is called significant only when it passes a statistical test and is at least five points. Anything else says “within normal variation”.',
          ],
          [
            '“Couldn’t check” is never zero',
            'If an engine fails to answer, we say so. A failed check is never counted as “not mentioned”.',
          ],
          [
            'Every number opens its evidence',
            'Click a figure and read the actual answers behind it.',
          ],
        ],
      },
    ],
    faq: [
      {
        q: 'How often is my brand checked?',
        a: 'Every week, automatically. You can also run a check on demand, within your plan’s allowance.',
      },
      {
        q: 'Where do the answers come from?',
        a: 'Licensed data providers and official APIs, not scraping of consumer apps by us. Each answer is labelled with how it was collected. The methodology page lists the method for each engine.',
      },
      {
        q: 'Can I choose the questions?',
        a: 'Yes. We suggest 25 to 50 buyer questions from your website, and you add, reword, pause or import your own.',
      },
    ],
    next: 'diagnose',
  },
  {
    slug: 'diagnose',
    step: 2,
    name: 'Diagnose',
    icon: 'search',
    title: 'Diagnose why AI skips your brand: AEO Corner',
    description:
      'Find out why AI engines don’t name you: whether AI crawlers can reach your site, whether your content is easy to quote, and which sources AI trusts about you.',
    h1: 'Find out why AI engines are not naming you',
    lead: 'A low score is only useful if it points at a cause. AEO Corner separates what your site does from what AI says, then shows the evidence for both.',
    sections: [
      {
        heading: 'What we look at',
        intro: 'We check your site the way an AI crawler meets it, in four areas.',
        items: [
          [
            'AI crawler access',
            'Whether the bots behind ChatGPT, Perplexity, Gemini and others are allowed in by your robots.txt, your firewall and your CDN.',
          ],
          [
            'Renderability',
            'Whether your main content is in the HTML a crawler receives, not only after JavaScript runs.',
          ],
          [
            'Structured data and entity clarity',
            'Valid markup, a clear About page, and a consistent name, address and profile links.',
          ],
          [
            'Answerability',
            'Question-style headings with a short direct answer underneath, lists, tables, FAQs and visible freshness.',
          ],
        ],
      },
      {
        heading: 'What you get',
        intro: 'A score, the gaps behind it, and the evidence for each.',
        items: [
          [
            'An AEO Readiness score out of 100',
            'Scored in six categories with the weights published on the methodology page.',
          ],
          [
            'Citation gaps',
            'Sites that AI cites in answers where you were not named, so you know where you are missing.',
          ],
          [
            'Competitor comparison',
            'How you stack up against each competitor you track, question by question.',
          ],
          [
            'Honest limits',
            'A check we could not run is shown as “couldn’t check” and left out of the score.',
          ],
        ],
      },
    ],
    faq: [
      {
        q: 'Do I need to give you access to my site?',
        a: 'No. The scan reads only your public pages. We identify ourselves as AEOCornerBot and follow your robots.txt; once you verify that you own the domain, we may read pages it asks other bots to skip, and only for your own project.',
      },
      {
        q: 'Are the readiness weights proven?',
        a: 'Not yet, and we say so. They are our first version, reasoned rather than tested against outcomes. We will calibrate them against real results and publish what changes.',
      },
      {
        q: 'Does it work on any website?',
        a: 'Any public website. The fixes we can apply directly are for WordPress; for other platforms we give you the exact change to make.',
      },
    ],
    next: 'fix',
  },
  {
    slug: 'fix',
    step: 3,
    name: 'Fix',
    icon: 'wrench',
    title: 'Fix your AI visibility gaps: AEO Corner',
    description:
      'A ranked list of fixes with the evidence behind each, plus a Content Studio that drafts pages for your approval. Nothing goes live on your site until you approve it.',
    h1: 'A ranked list of fixes, and drafts ready to approve',
    lead: 'The Action Center turns what we found into the next thing to do, in order of expected impact. You stay in control of everything that reaches your site.',
    sections: [
      {
        heading: 'The Action Center',
        intro: 'It turns what we found into the next thing to do, in order.',
        items: [
          [
            'Ranked by impact',
            'Each fix is scored by impact, our confidence and the effort, and links to the check or the answers it came from.',
          ],
          ['Plain steps', 'What to change, why it matters, and how to tell it worked.'],
          [
            'No repeats',
            'A fix you finish, dismiss or have already won does not keep coming back.',
          ],
        ],
      },
      {
        heading: 'The Content Studio',
        intro:
          'When a fix needs a page, we help you write it, and you approve it before anything is published.',
        items: [
          [
            'Researched, with sources',
            'Facts are kept only when we can point to the page they came from. Anything unchecked is shown to you and not given to the draft.',
          ],
          [
            'Written for answers',
            'Question headings with short direct answers, and structured data we generate and validate in code, not by a language model.',
          ],
          [
            'You approve every word',
            'A person approves each draft after a quality check. Any edit after approval takes the approval away.',
          ],
          [
            'Publish to WordPress',
            'Connect your site and publish, or save it as a WordPress draft. A refreshed page is updated in place.',
          ],
        ],
      },
    ],
    faq: [
      {
        q: 'Will you change my website without asking?',
        a: 'Never. You see the exact change first, and nothing is published until a person with the right role approves it.',
      },
      {
        q: 'Do you write articles in bulk?',
        a: 'No. Mass-published AI articles are on the list of things we will not do. Each draft is for one page, with sources, and needs a human to approve it.',
      },
      {
        q: 'What if I am not on WordPress?',
        a: 'You can export the approved text as HTML or Markdown and put it on your site yourself.',
      },
    ],
    next: 'prove',
  },
  {
    slug: 'prove',
    step: 4,
    name: 'Prove',
    icon: 'target',
    title: 'Prove what worked: AEO Corner',
    description:
      'After a fix, AEO Corner checks that it is live, then re-measures AI answers and tells you whether they really changed or whether it is normal variation.',
    h1: 'Know whether a fix actually changed AI answers',
    lead: 'Most tools stop at the score. We check the fix is live the same day, then compare AI answers before and after, and say plainly when we cannot tell yet.',
    sections: [
      {
        heading: 'Two kinds of proof',
        intro:
          'Whether a fix is live is a different question from whether it worked, so we answer them separately.',
        items: [
          [
            'Verified the same day',
            'We look at your page again to confirm the fix is live: found, indexable, showing its headline and carrying its structured data.',
          ],
          [
            'Proven over weeks',
            'We compare the answers before the fix with the answers after it, at two and four weeks.',
          ],
        ],
      },
      {
        heading: 'Straight about the result',
        intro: 'We say what the numbers show, including when they show nothing yet.',
        items: [
          [
            'A verdict, with the numbers',
            'A gain, a decline, no change, or not enough data yet, each with the counts behind it.',
          ],
          [
            'No overclaiming',
            '“Not enough data” is never shown as “no change”, and a change inside normal variation is labelled that way.',
          ],
          [
            'Weekly digest and alerts',
            'A Monday summary of what changed and what to do next, and alerts for significant drops and negative claims.',
          ],
          [
            'AI traffic',
            'Connect Google Analytics and Search Console to see visits that came from AI engines alongside the answers.',
          ],
        ],
      },
    ],
    faq: [
      {
        q: 'How soon will I see proof?',
        a: 'The fix itself is checked within hours. The before-and-after comparison of AI answers takes two to four weeks, because it needs enough answers to tell a real change from noise.',
      },
      {
        q: 'Can you promise my score will go up?',
        a: 'No. AEO Corner measures what AI engines say; it cannot promise to change it. What we promise is an honest account of whether it did.',
      },
      {
        q: 'What is the digest?',
        a: 'A weekly email, sent Monday morning in your timezone, with your figures, what changed significantly and your next actions. You can switch it off or unsubscribe with one click.',
      },
    ],
    next: null,
  },
];

export const stageBySlug = Object.fromEntries(stages.map((s) => [s.slug, s]));

export const agency = {
  title: 'AEO Corner for agencies: AI visibility for every client',
  description:
    'Run the free audit as a sales tool, track every client in one account, and give each client read-only access to their own results.',
  h1: 'AI visibility reporting for every client you manage',
  lead: 'Your clients are starting to ask whether ChatGPT recommends them. AEO Corner lets you answer with evidence, track many clients in one account, and show what your work changed.',
  sections: [
    {
      heading: 'How agencies use it',
      intro: 'The same tools, organised around your clients.',
      items: [
        [
          'Win the pitch with the audit',
          'Run the free audit on a prospect’s domain and show what AI says about them next to their competitors.',
        ],
        [
          'One account, many clients',
          'Each client is a project with its own brand, competitors, questions and results, and a switcher to move between them.',
        ],
        [
          'Read-only client seats',
          'Give a client access to their own project only. They cannot see your other clients.',
        ],
        [
          'Reports that prove the work',
          'Before-and-after cards show what changed after a fix, with the numbers and the honest caveats.',
        ],
      ],
    },
    {
      heading: 'What is on the Agency plan',
      intro: 'More room, plus the features agencies ask for.',
      items: [
        [
          'More room',
          'More projects and more tracked questions than the other plans. The pricing page shows the current numbers.',
        ],
        ['Weekly digests and alerts', 'Per-project summaries and alerts on significant drops.'],
        [
          'WordPress publishing',
          'Publish approved drafts to a client’s WordPress site, with that client’s approval.',
        ],
      ],
    },
  ],
  faq: [
    {
      q: 'Can my client see other clients’ data?',
      a: 'No. A client seat is limited to the projects you choose, and every other project is invisible to it.',
    },
    {
      q: 'Is there white-label reporting?',
      a: 'Not yet. Client seats and the dashboard are available now; branded and exportable reports are planned for later.',
    },
    {
      q: 'Do I need the client’s permission to audit them?',
      a: 'The audit reads only public pages and asks AI engines public questions, the same as anyone could. To track a project we ask you to verify that you control the domain before we do anything beyond the public view.',
    },
  ],
};

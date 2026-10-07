# Free tools: copy for sign-off

| | |
|---|---|
| **Document** | Free tools copy, drafted from the live definitions |
| **Date** | 2026-10-07 |
| **Status** | Draft for founder sign-off (Milestone 17, task 17.12). Nothing here is final until you approve it |
| **Companion docs** | [MILESTONES_FREE_TOOLS.md](MILESTONES_FREE_TOOLS.md) (decisions G1–G5) |

How to review: each section is one public page, `/tools/<slug>`. Every page says what the tool cannot see (decision G5), has an FAQ with direct answers, and points to the free audit. Mark anything you want changed; the text lives in `src/web/tools/<slug>.js`.

## 1. Robots.txt checker for AI crawlers

- **Address:** `/tools/robots-txt-checker`
- **Page title:** Robots.txt checker for AI crawlers (free) | AEO Corner
- **Search description:** Free robots.txt checker: see which AI crawlers (GPTBot, ClaudeBot, PerplexityBot, Google, Bing) your site allows or blocks. No account needed.
- **Opening line:** Enter your website address and see which AI crawlers your robots.txt allows or blocks, from OpenAI, Anthropic, Perplexity, Google, Microsoft and Apple.
- **Button:** Check my robots.txt
- **Needs a bot check:** yes (it reads a website)

**What this tool cannot tell you**

robots.txt is a request, not a lock. This tool reads the file and says what it asks of each AI crawler. It cannot tell you whether a firewall turns a crawler away, whether an AI engine has read your pages, or whether any engine names your brand. The free audit checks the firewall and asks the engines.

**Questions**

- **Which AI crawlers does this check?** The answer and search crawlers of OpenAI, Anthropic, Perplexity, Google, Microsoft and Apple, plus the training crawlers of Google, Apple, Meta and Common Crawl, and a few others. Each one is judged by the rules that name it, or by the rules for every crawler if none does.
- **Should I block GPTBot or ClaudeBot?** That is your choice. Training crawlers collect pages to train models, and search and answer crawlers fetch pages to answer a question. You can allow one kind and block the other. Blocking the search and answer crawlers can keep your pages out of those engines’ answers.
- **What if my site has no robots.txt?** Then every crawler may read everything, and that is not an error. Crawlers treat a missing robots.txt as no restrictions. You only need one if you want to ask some crawlers to stay away or to point them to your sitemap.
- **Does “allowed” mean AI will mention my brand?** No. Allowed means robots.txt does not ask the crawler to stay away. Whether an engine names you depends on what it finds and trusts. The free audit asks ChatGPT, Perplexity, Gemini and Google AI Overviews and shows you the real answers.

## 2. Structured data validator (JSON-LD)

- **Address:** `/tools/structured-data-validator`
- **Page title:** Structured data validator for JSON-LD (free) | AEO Corner
- **Search description:** Free JSON-LD validator: paste your structured data or give a page address and see what is wrong, with plain explanations. No account needed.
- **Opening line:** Give a page address, or paste your JSON-LD, and see whether it is valid structured data, what is wrong and where.
- **Button:** Check my structured data
- **Needs a bot check:** yes (it reads a website)

**What this tool cannot tell you**

This tool checks the structure and values of structured data in a page’s HTML, or in what you paste. It cannot tell you whether a search or AI engine will use it. It does not run JavaScript, so data a script adds after the page loads is not seen.

**Questions**

- **What is JSON-LD?** JSON-LD is a block of data in a web page that says what the page is about in a form software can read: who the business is, what an article is, what the questions and answers are. Search engines and AI crawlers read it.
- **Which types does this validator check?** It checks the types listed at the bottom of each result in detail: the structure, the @context, dates, web addresses and the properties it knows. Any other type or property is read for syntax only, and listed as not checked, because we cannot say it is wrong.
- **Why does it say it found no structured data on my page?** Either the page has none, or a script adds it after the page loads. This tool reads the HTML the server sends, as a crawler that does not run JavaScript would. If your structured data comes from a script, put it in the server’s HTML instead.
- **Is my pasted code saved?** No. We read it, show you the result, and keep nothing. A pasted block never leaves our server, and we make no request to any other site for it.

## 3. Sitemap checker

- **Address:** `/tools/sitemap-checker`
- **Page title:** Sitemap checker for search and AI crawlers (free) | AEO Corner
- **Search description:** Free sitemap checker: see whether your site has an XML sitemap, whether robots.txt points to it, and how many pages and dates it lists. No account needed.
- **Opening line:** Enter your website address, or the address of a sitemap, and see whether you have one, whether robots.txt points to it, and how many pages and dates it lists.
- **Button:** Check my sitemap
- **Needs a bot check:** yes (it reads a website)

**What this tool cannot tell you**

This tool reads your sitemap and counts its addresses and dates. It cannot tell you whether search or AI engines have fetched, indexed or used those pages. A sitemap only tells crawlers where your pages are. We read up to three sitemaps in an index.

**Questions**

- **Do I need a sitemap?** Not always. Crawlers also find pages by following links. A sitemap helps most when a site is large, new, or has pages that few links point to, and it can tell crawlers which pages changed.
- **Where should my sitemap be?** Most sites put it at /sitemap.xml, and add a Sitemap line to robots.txt with its full address so crawlers can find it wherever it is. This tool checks both places.
- **What is a sitemap index?** A big site can split its sitemap into several files and list them in one index file. This tool reads the index and up to three of the files it lists, so the count may be for only part of the site.
- **Why does it say some addresses are on another site?** A sitemap may list only addresses on the site that hosts it, and crawlers ignore the others. This often means an old domain name was left in the file after a move.

## 4. Robots.txt generator for AI crawlers

- **Address:** `/tools/robots-txt-generator`
- **Page title:** Robots.txt generator for AI crawlers (free) | AEO Corner
- **Search description:** Free robots.txt generator: choose which AI crawlers to allow or block, add your sitemap, and copy or download the file. It never blocks Google or Bing.
- **Opening line:** Choose which AI crawlers may read your site, add your sitemap, and copy or download a robots.txt that does exactly that.
- **Button:** Make my robots.txt
- **Needs a bot check:** no (it runs on what is typed)

**What this tool cannot tell you**

This tool writes a robots.txt from your choices. It does not edit your site or replace your current file, so compare it with the one you have. robots.txt is a request that well-behaved crawlers follow, not a lock, and it cannot make an AI engine mention you.

**Questions**

- **Which crawlers does this generator block?** Only the AI crawlers you choose to block, in three groups: answer crawlers, training crawlers and others. It never blocks Googlebot, Bingbot or Applebot, so blocking AI crawlers here does not take you out of ordinary search.
- **Should I block AI answer crawlers?** Usually not. They fetch pages so an AI engine can answer a question, so blocking them can keep your pages out of those answers. Training crawlers collect pages to train models, and blocking them is a business choice.
- **Where do I put the file?** Save it as robots.txt in the top folder of your website, so it opens at yourcompany.com/robots.txt. If you already have one, compare the two first, because this file replaces everything in it. Then check it with the robots.txt checker.
- **What are the paths for?** A path such as /admin/ asks every crawler to stay out of that part of your site. List one per line, starting with a slash. A path of just a slash is refused, because it would block your whole site.

## 5. Schema markup generator (JSON-LD)

- **Address:** `/tools/schema-markup-generator`
- **Page title:** Schema markup generator for JSON-LD (free) | AEO Corner
- **Search description:** Free schema markup generator: make valid JSON-LD for an organization, a local business, an FAQ or an article, and copy or download it. No account needed.
- **Opening line:** Choose a type, fill in what you know, and copy valid JSON-LD structured data for your page. It writes only what you type.
- **Button:** Make my markup
- **Needs a bot check:** no (it runs on what is typed)

**What this tool cannot tell you**

This tool writes structured data from what you type and checks that it is valid. It cannot check that it is true, or that it matches your page, which it must. It cannot promise a rich result in search or a mention in an AI answer. Leave a field empty and it is left out.

**Questions**

- **What is schema markup?** Schema markup is a block of structured data in your page, usually JSON-LD, that says in a form software can read who you are or what the page is. Search engines and AI crawlers read it.
- **Does this tool make anything up?** No. It writes only what you type, and leaves empty fields out. It checks the result with the same validator as our structured data validator, and it will not give you markup that fails that check.
- **Where do I paste the markup?** Paste the whole block into the HTML of the page it describes, inside the head or the body. Put Organization markup on your home page once, and put Article markup on the article’s own page.
- **Will schema markup get me into AI answers?** We cannot promise that, and nobody can. Markup helps crawlers read your page correctly. Whether an AI engine names you depends on much more. The free audit asks the engines and shows you the real answers.

## 6. llms.txt generator

- **Address:** `/tools/llms-txt-generator`
- **Page title:** llms.txt generator (free) | AEO Corner
- **Search description:** Free llms.txt generator: add your name, a summary and your key pages, then copy or download the file. No engine is known to need one. No account needed.
- **Opening line:** Add your name, a one-line summary and up to ten key pages, and copy or download an llms.txt in the common format.
- **Button:** Make my llms.txt
- **Needs a bot check:** no (it runs on what is typed)

**What this tool cannot tell you**

This tool writes an llms.txt from what you type. No AI engine is known to need the file, and nobody has shown that it changes what an engine says about you. It cannot check that your links work. Adding it is harmless.

**Questions**

- **What is an llms.txt file?** It is a short Markdown file at the top of your site that names your business and lists your key pages with a line about each. It was proposed as a way to point AI tools at the pages that matter.
- **Do AI engines use llms.txt?** No engine is known to need it. Some have not said whether they read it, and nobody has shown that it changes what an engine says about you. It is harmless to add, so treat it as a small extra.
- **Where do I put the file?** Save it as llms.txt in the top folder of your website, so it opens at yourcompany.com/llms.txt. Our free audit looks for it and reports it as information only, never as a failure.
- **What should I list in it?** Your best pages for a newcomer: what you do, pricing, a guide or two, and how to contact you. Keep it to ten at most. Every link needs a title, and a short note on what the page covers helps.


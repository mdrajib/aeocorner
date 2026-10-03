# ADR-0009: Charts: Chart.js, self-hosted, with the data table as the chart

| | |
|---|---|
| **Status** | Accepted |
| **Date** | 2026-10-03 |
| **Context of discovery** | [MILESTONES.md Milestone 5](../MILESTONES.md#milestone-5--dashboard--design-partner-beta--m2), task 5.03 "Choose and vendor a CSP-safe chart library (Chart.js or ECharts)". [ADR-0003](0003-strict-csp.md) said to check each library's CSP notes when it is added and record any exception. |

## Context

The dashboard needs trend lines with a 95% band and gaps, and bar charts for share of voice. The app's policy ([ADR-0003](0003-strict-csp.md)) allows no `unsafe-eval`, no inline script and no `style=""` attribute. The product also promises that a missing reading is never drawn as zero ([UI_DESIGN §7](../UI_DESIGN.md)), and the accessibility sweep runs axe over every screen.

## Decision

**Chart.js 4.5.1**, copied by `npm run vendor` to `src/web/public/vendor/chart.umd.min.js` like htmx and Alpine. A page that has a chart sets `charts: true`, which makes the layout load the file before `components.js`; other pages do not carry its 200 KB.

| | Chart.js | ECharts |
|---|---|---|
| Size (minified) | about 200 KB | about 1 MB for the full build |
| Draws on | one `<canvas>` | canvas or SVG |
| Needs `unsafe-eval` | no (the shipped file has no `eval` or `new Function`) | no for the basic build; some builds and options use it |
| Fits our charts | line with gaps (`spanGaps: false`), shaded band (`fill` between two datasets), bar | all that, and much we do not need (maps, 3-D, graphs) |

Chart.js is smaller and does everything on the list. ECharts would be the choice for a dashboard builder; this is a fixed set of screens.

**How it is used (`ui.chart`, `src/web/views/components/chart.ejs`):**

1. **The table is the chart.** The component always writes the numbers as a table (`ui.table`). Without JavaScript that table is the whole chart; with it, the picture is drawn from the same numbers and the table folds away behind "Values as a table". A screen reader gets the table and a one-sentence summary on the canvas (`role="img"`).
2. **The data travels in a `data-chart` attribute**, not in an inline `<script>`, so no view carries a script block.
3. **A missing value is `null`.** The line breaks there (`spanGaps: false`), and the table says "Couldn't check". The band is two invisible lines with the space between them shaded.
4. **Colour is never the only cue.** Each series also has its own dash and point shape. Colours come from the design tokens (`--color-*`), read at draw time, so a token change reaches the charts.
5. **Motion follows `prefers-reduced-motion`.** Animation is switched off for visitors who ask for that.

## Consequences

- Chart.js sets `style` properties on the canvas through the browser's CSS object model. A strict `style-src` blocks inline `style=""` attributes and `<style>` blocks, not those property writes, so no exception to the policy is needed. The Playwright sweep fails on any console error, so a CSP violation from a Chart.js upgrade would fail the build.
- The canvas is not read by axe, so the table and the sentence are what we test for accessibility.
- Content Studio (Milestone 7) has no charts; if a later screen needs a type Chart.js lacks, add it here before reaching for a second library.

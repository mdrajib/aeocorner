// Email clients can't read CSS variables, so email templates repeat a handful of design tokens as hex.
// These MUST match tailwind/tokens.css — src/lib/email.test.js fails if they drift.
export const emailTokens = {
  'ink-950': '#0b1020',
  'ink-900': '#0f172a',
  'ink-700': '#334155',
  'ink-600': '#475569',
  'ink-200': '#e2e8f0',
  'ink-50': '#f8fafc',
  'brand-600': '#4f46e5',
  'brand-700': '#4338ca',
  'signal-400': '#a3e635',
};

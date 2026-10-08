/** Bangladeshi taka as text (ADR-0018). Kept apart from the billing rules so both the screen and the rules can use it. */

/** "৳2,500" (whole taka) or "৳2,499.50". */
export function takaText(amount) {
  const n = Number(amount);
  const whole = Number.isInteger(n);
  return `৳${n.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** The amount as bKash wants it: a string with two decimals. */
export const amountString = (amount) => Number(amount).toFixed(2);

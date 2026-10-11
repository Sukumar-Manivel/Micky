// Money helpers. The API only ever sends and receives integer paise (₹1 = 100 paise),
// because floating-point rupees (0.1 + 0.2 !== 0.3) would slowly corrupt balances.

// 'en-IN' gives Indian digit grouping: 1,00,000 (one lakh), not 100,000.
const withPaise = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const wholeRupees = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** 150000 → "₹1,500"; 150050 → "₹1,500.50". Paise are shown only when they are not zero. */
export function formatINR(paise: number): string {
  const rupees = paise / 100;
  return paise % 100 === 0 ? wholeRupees.format(rupees) : withPaise.format(rupees);
}

/**
 * Parses what a person typed in a rupee field ("1,500", "1500.5", "₹ 2,000") into paise.
 * Returns null for anything that is not a non-negative amount with at most 2 decimals.
 */
export function rupeesToPaise(input: string): number | null {
  const cleaned = input.replace(/[₹,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ''] = cleaned.split('.');
  // Build the integer from strings so we never multiply a float by 100.
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}

/** Paise → a plain rupee string for an input box: 150000 → "1500", 150050 → "1500.50". */
export function paiseToRupeeInput(paise: number): string {
  const whole = Math.floor(paise / 100);
  const fraction = paise % 100;
  return fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(2, '0')}`;
}

/** Price limits from API.md (₹100 – ₹1,00,000), in paise. */
export const MIN_PRICE_PAISE = 100_00;
export const MAX_PRICE_PAISE = 1_00_000_00;

import { describe, expect, it } from 'vitest';
import { formatINR, paiseToRupeeInput, rupeesToPaise } from './money';

describe('formatINR', () => {
  it('uses Indian digit grouping', () => {
    expect(formatINR(1_00_000_00)).toBe('₹1,00,000');
    expect(formatINR(12_34_567_00)).toBe('₹12,34,567');
  });
  it('hides zero paise and shows non-zero paise', () => {
    expect(formatINR(1_500_00)).toBe('₹1,500');
    expect(formatINR(1_500_50)).toBe('₹1,500.50');
    expect(formatINR(5)).toBe('₹0.05');
  });
});

describe('rupeesToPaise', () => {
  it('parses plain and formatted input without float errors', () => {
    expect(rupeesToPaise('1500')).toBe(150000);
    expect(rupeesToPaise('₹ 1,00,000')).toBe(10000000);
    expect(rupeesToPaise('0.29')).toBe(29);
    expect(rupeesToPaise('19.9')).toBe(1990);
  });
  it('rejects junk', () => {
    expect(rupeesToPaise('')).toBeNull();
    expect(rupeesToPaise('-5')).toBeNull();
    expect(rupeesToPaise('1.234')).toBeNull();
    expect(rupeesToPaise('abc')).toBeNull();
  });
  it('round-trips with paiseToRupeeInput', () => {
    for (const p of [0, 5, 100, 150050, 10000000]) expect(rupeesToPaise(paiseToRupeeInput(p))).toBe(p);
  });
});

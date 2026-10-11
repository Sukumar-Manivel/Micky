import { priceFor, splitSale } from '../common/money.js';
import { type LicenceState, licenceBlocker } from './licence-rules.js';

const fresh: LicenceState = {
  mediaStatus: 'APPROVED',
  exclusiveSold: false,
  paidOrderCount: 0,
  buyerHasPaid: false,
};

describe('licenceBlocker', () => {
  it('allows both licences on fresh approved media', () => {
    expect(licenceBlocker(fresh, 'EXCLUSIVE')).toBeNull();
    expect(licenceBlocker(fresh, 'NON_EXCLUSIVE')).toBeNull();
  });

  it('blocks media that is not APPROVED', () => {
    for (const status of [
      'IN_REVIEW',
      'REJECTED',
      'REMOVED',
      'PROCESSING',
      'FAILED',
    ] as const) {
      expect(
        licenceBlocker({ ...fresh, mediaStatus: status }, 'NON_EXCLUSIVE'),
      ).toMatch(/no longer available/);
    }
  });

  it('blocks exclusive once anyone has paid', () => {
    expect(
      licenceBlocker({ ...fresh, paidOrderCount: 1 }, 'EXCLUSIVE'),
    ).toMatch(/exclusive licence is no longer/i);
    expect(
      licenceBlocker({ ...fresh, paidOrderCount: 1 }, 'NON_EXCLUSIVE'),
    ).toBeNull();
  });

  it('blocks everything after an exclusive sale', () => {
    const sold = { ...fresh, exclusiveSold: true, paidOrderCount: 1 };
    expect(licenceBlocker(sold, 'NON_EXCLUSIVE')).toMatch(/exclusively/);
    expect(licenceBlocker(sold, 'EXCLUSIVE')).toMatch(/exclusively/);
  });

  it('allows each channel to buy each media only once', () => {
    expect(
      licenceBlocker(
        { ...fresh, paidOrderCount: 1, buyerHasPaid: true },
        'NON_EXCLUSIVE',
      ),
    ).toMatch(/already bought/);
  });
});

describe('splitSale (money rounding)', () => {
  it('splits round amounts exactly', () => {
    expect(splitSale(1_500_00, 30)).toEqual({
      platformFee: 450_00,
      uploaderShare: 1_050_00,
    });
  });

  it('rounds the platform fee down so the uploader gets the odd paisa', () => {
    // 30% of 333 paise = 99.9 → fee 99, uploader 234.
    expect(splitSale(333, 30)).toEqual({ platformFee: 99, uploaderShare: 234 });
    // 30% of 1 paisa = 0.3 → fee 0, uploader 1.
    expect(splitSale(1, 30)).toEqual({ platformFee: 0, uploaderShare: 1 });
  });

  it('always adds up to the amount and stays in whole paise', () => {
    for (const amount of [1, 7, 99, 100_00, 12_345, 99_999_99, 1_00_000_00]) {
      for (const pct of [0, 1, 15, 30, 33, 99, 100]) {
        const { platformFee, uploaderShare } = splitSale(amount, pct);
        expect(platformFee + uploaderShare).toBe(amount);
        expect(
          Number.isInteger(platformFee) && Number.isInteger(uploaderShare),
        ).toBe(true);
        expect(platformFee).toBeGreaterThanOrEqual(0);
        expect(uploaderShare).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('priceFor picks the price of the licence type', () => {
    const item = { priceNonExclusive: 500_00, priceExclusive: 2_000_00 };
    expect(priceFor(item, 'NON_EXCLUSIVE')).toBe(500_00);
    expect(priceFor(item, 'EXCLUSIVE')).toBe(2_000_00);
  });
});

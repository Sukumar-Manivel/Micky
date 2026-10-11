import { trendScore } from './trend.js';

const NOW = new Date('2026-10-10T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe('trendScore', () => {
  it('matches the formula', () => {
    const score = trendScore({
      uploaderCount: 2,
      mediaCount: 3,
      viewCount: 4,
      verificationBonus: 1,
      firstSeenAt: hoursAgo(2),
      now: NOW,
    });
    // (3*2 + 3 + 0.5*4 + 1) / (2 + 2)^1.8 = 12 / 4^1.8
    expect(score).toBeCloseTo(12 / Math.pow(4, 1.8), 10);
  });

  it('is 0 for an incident with no approved media and no views', () => {
    expect(
      trendScore({ uploaderCount: 0, mediaCount: 0, viewCount: 0, verificationBonus: 0, firstSeenAt: NOW, now: NOW }),
    ).toBe(0);
  });

  it('decays with age', () => {
    const base = { uploaderCount: 1, mediaCount: 1, viewCount: 0, verificationBonus: 0, now: NOW };
    const fresh = trendScore({ ...base, firstSeenAt: hoursAgo(1) });
    const old = trendScore({ ...base, firstSeenAt: hoursAgo(24) });
    expect(fresh).toBeGreaterThan(old);
  });

  it('values distinct witnesses more than many uploads from one person', () => {
    const base = { viewCount: 0, verificationBonus: 0, firstSeenAt: hoursAgo(1), now: NOW };
    const threeWitnesses = trendScore({ ...base, uploaderCount: 3, mediaCount: 3 });
    const oneSpammer = trendScore({ ...base, uploaderCount: 1, mediaCount: 6 });
    expect(threeWitnesses).toBeGreaterThan(oneSpammer);
  });

  it('treats a first-seen time in the future as age 0', () => {
    const base = { uploaderCount: 1, mediaCount: 1, viewCount: 0, verificationBonus: 0, now: NOW };
    expect(trendScore({ ...base, firstSeenAt: hoursAgo(-5) })).toBe(trendScore({ ...base, firstSeenAt: NOW }));
  });
});

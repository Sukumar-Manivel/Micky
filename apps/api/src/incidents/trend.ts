// The trending score of an incident (see docs/RESEARCH.md, "Trending score").
//
//   score = (3 × uploaders + uploads + 0.5 × views + verificationBonus) / (hoursSinceFirstSeen + 2)^1.8
//
// It is the Hacker News "gravity" formula: the numerator is how much evidence
// and interest an incident has; the denominator grows with age, so an old
// incident sinks even if it was big. The +2 stops brand-new incidents from
// dividing by almost zero and jumping to the top with a single upload.
//
// Distinct uploaders weigh 3× more than uploads, so one person posting ten
// clips cannot make an incident trend on their own.

export const GRAVITY = 1.8;

export interface TrendInput {
  uploaderCount: number;
  mediaCount: number;
  viewCount: number;
  /** One point per approved upload with valid Content Credentials. */
  verificationBonus: number;
  firstSeenAt: Date;
  now: Date;
}

export function trendScore(input: TrendInput): number {
  const points = 3 * input.uploaderCount + input.mediaCount + 0.5 * input.viewCount + input.verificationBonus;
  if (points <= 0) return 0;
  // Clamp at 0 so a capture time slightly in the future cannot shrink the denominator.
  const ageHours = Math.max(0, (input.now.getTime() - input.firstSeenAt.getTime()) / 3_600_000);
  return points / Math.pow(ageHours + 2, GRAVITY);
}

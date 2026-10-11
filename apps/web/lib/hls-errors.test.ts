import { describe, expect, it } from 'vitest';
import { MAX_SESSION_REFRESHES, MEDIA_RECOVERY_WINDOW_MS, createHlsErrorPolicy, unplayableMessage } from './hls-errors';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('createHlsErrorPolicy', () => {
  it('gives up on a media error that keeps coming back (regression: endless segment reload loop)', () => {
    // A browser without H.264 support fails with bufferAddCodecError on every attempt.
    const c = clock();
    const decide = createHlsErrorPolicy(c.now);
    const actions = [];
    for (let i = 0; i < 50; i++) {
      actions.push(decide({ type: 'mediaError' }));
      c.advance(5);
    }
    expect(actions.slice(0, 3)).toEqual(['recover-media', 'swap-codec-and-recover', 'give-up']);
    expect(actions.filter((a) => a !== 'give-up')).toHaveLength(2);
  });

  it('recovers again from an isolated media error much later', () => {
    const c = clock();
    const decide = createHlsErrorPolicy(c.now);
    expect(decide({ type: 'mediaError' })).toBe('recover-media');
    c.advance(MEDIA_RECOVERY_WINDOW_MS + 1);
    expect(decide({ type: 'mediaError' })).toBe('recover-media');
  });

  it('refreshes the session on network errors, but not in a tight loop', () => {
    const c = clock();
    const decide = createHlsErrorPolicy(c.now);
    for (let i = 0; i < MAX_SESSION_REFRESHES; i++) expect(decide({ type: 'networkError' })).toBe('refresh-session');
    expect(decide({ type: 'networkError' })).toBe('give-up');
    expect(decide({ type: 'otherError' })).toBe('give-up');
    // A minute later (e.g. the next 10-minute token expiry) refreshing works again.
    c.advance(60_001);
    expect(decide({ type: 'networkError' })).toBe('refresh-session');
  });

  it('explains why it gave up', () => {
    expect(unplayableMessage('mediaError')).toMatch(/cannot play/);
    expect(unplayableMessage('networkError')).toMatch(/could not be loaded/);
  });
});

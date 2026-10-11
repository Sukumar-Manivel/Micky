import { AppConfig } from './app-config.js';

const LONG = 'x'.repeat(40);

function withEnv(env: Record<string, string | undefined>, fn: () => void) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) {
    if (/^(NODE_ENV|APP_ROLE|JWT_|SIGNING_|INTERNAL_|PAYMENTS_|RAZORPAY_|EARNINGS_|PAYOUT_|SESSION_|REFRESH_|LOGIN_)/.test(k)) {
      delete process.env[k];
    }
  }
  Object.assign(process.env, env);
  try {
    fn();
  } finally {
    process.env = saved;
  }
}

describe('AppConfig', () => {
  it('has the commerce settings with their defaults', () => {
    withEnv({ NODE_ENV: 'test' }, () => {
      const c = new AppConfig();
      expect(c.earningsHoldDays).toBe(7);
      expect(c.payoutCooldownHours).toBe(24);
      expect(c.sessionMaxDays).toBe(30);
    });
  });

  it('validates the ranges of the new settings', () => {
    withEnv({ NODE_ENV: 'test', EARNINGS_HOLD_DAYS: '-1' }, () => {
      expect(() => new AppConfig()).toThrow(/EARNINGS_HOLD_DAYS must be between 0 and 180/);
    });
    withEnv({ NODE_ENV: 'test', PAYOUT_COOLDOWN_HOURS: '1.5' }, () => {
      expect(() => new AppConfig()).toThrow(/PAYOUT_COOLDOWN_HOURS must be an integer/);
    });
    withEnv({ NODE_ENV: 'test', SESSION_MAX_DAYS: '3', REFRESH_TTL_DAYS: '7' }, () => {
      expect(() => new AppConfig()).toThrow(/SESSION_MAX_DAYS must be at least REFRESH_TTL_DAYS/);
    });
  });

  it('requires only the API secrets in the production API process', () => {
    const api = { NODE_ENV: 'production', PAYMENTS_PROVIDER: 'razorpay', RAZORPAY_KEY_ID: 'k', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w' };
    withEnv({ ...api, SIGNING_SECRET: LONG }, () => {
      expect(() => new AppConfig()).toThrow(/JWT_ACCESS_SECRET is required in production/);
    });
    withEnv({ ...api, SIGNING_SECRET: LONG, JWT_ACCESS_SECRET: LONG }, () => {
      const c = new AppConfig();
      // The API never calls the verifier, so it gets no INTERNAL_TOKEN: a random value, not a default.
      expect(c.internalToken).not.toMatch(/dev-insecure/);
      expect(c.internalToken.length).toBeGreaterThanOrEqual(32);
    });
  });

  it('requires only INTERNAL_TOKEN in the production worker (no JWT, signing or Razorpay keys)', () => {
    withEnv({ NODE_ENV: 'production', APP_ROLE: 'worker' }, () => {
      expect(() => new AppConfig()).toThrow(/INTERNAL_TOKEN is required in production/);
    });
    withEnv({ NODE_ENV: 'production', APP_ROLE: 'worker', INTERNAL_TOKEN: LONG }, () => {
      const c = new AppConfig();
      expect(c.jwtAccessSecret).not.toMatch(/dev-insecure/);
    });
  });

  it('still refuses short secrets and the mock payment provider in production', () => {
    withEnv({ NODE_ENV: 'production', APP_ROLE: 'worker', INTERNAL_TOKEN: 'short' }, () => {
      expect(() => new AppConfig()).toThrow(/at least 32 characters/);
    });
    withEnv({ NODE_ENV: 'production', JWT_ACCESS_SECRET: LONG, SIGNING_SECRET: LONG }, () => {
      expect(() => new AppConfig()).toThrow(/PAYMENTS_PROVIDER=mock is not allowed/);
    });
  });
});

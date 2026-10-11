import type { Redis } from 'ioredis';
import type { AppConfig } from '../../config/app-config.js';
import { LoginBackoffService } from './login-backoff.service.js';

const config = { loginFreeAttempts: 5, loginBackoffBaseSec: 30, loginBackoffMaxSec: 900 } as AppConfig;
const service = new LoginBackoffService({} as Redis, config);

describe('LoginBackoffService.lockSecondsFor', () => {
  it('lets the first 5 failures through without a lock (typos)', () => {
    for (let n = 0; n <= 5; n += 1) expect(service.lockSecondsFor(n)).toBe(0);
  });

  it('doubles from the 6th failure and stops at the cap', () => {
    expect([6, 7, 8, 9, 10, 11, 12, 100].map((n) => service.lockSecondsFor(n))).toEqual([
      30, 60, 120, 240, 480, 900, 900, 900,
    ]);
  });
});

describe('LoginBackoffService with Redis down', () => {
  const broken = {
    pttl: () => Promise.reject(new Error('ECONNREFUSED')),
    multi: () => {
      throw new Error('ECONNREFUSED');
    },
  } as unknown as Redis;
  const failOpen = new LoginBackoffService(broken, config);

  it('fails open instead of locking everyone out', async () => {
    await expect(failOpen.assertAllowed('a@b.in')).resolves.toBeUndefined();
    await expect(failOpen.recordFailure('a@b.in')).resolves.toBe(0);
  });
});

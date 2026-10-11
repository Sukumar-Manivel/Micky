import { describe, expect, it } from 'vitest';
import { safeNext } from './safe-next';

const ORIGIN = 'https://micky.in';

describe('safeNext (open redirect after login, REVIEW M2)', () => {
  it.each([
    ['/\\evil.example', 'backslash: the URL parser reads it as //evil.example'],
    ['/\\evil.example/login', 'the exact payload from the review'],
    ['/\t/evil.example', 'tab-prefixed path: the tab is stripped, leaving //evil.example'],
    ['/\n/evil.example', 'newline, stripped the same way'],
    ['/\r\n/evil.example', 'CR LF'],
    ['//evil', 'protocol-relative'],
    ['//evil.example/path', 'protocol-relative with a path'],
    ['https://evil', 'absolute URL'],
    ['https://evil.example/login', 'absolute URL with a path'],
    ['http://micky.in/newsroom', 'absolute, even on our own host (http, other origin)'],
    ['javascript:alert(1)', 'script URL'],
    ['/..//evil.example', 'dot segments that normalise to //evil.example'],
    ['/././/evil.example', 'more dot segments'],
    ['evil.example', 'relative without a slash'],
    ['', 'empty'],
    ['/login?next=/newsroom', 'the login page itself (would loop)'],
  ])('rejects %j (%s)', (next) => {
    expect(safeNext(next, ORIGIN)).toBeNull();
  });

  it('rejects null and very long values', () => {
    expect(safeNext(null, ORIGIN)).toBeNull();
    expect(safeNext(`/${'a'.repeat(3000)}`, ORIGIN)).toBeNull();
  });

  it.each([
    ['/newsroom', '/newsroom'],
    ['/newsroom/media/123?tab=preview#buy', '/newsroom/media/123?tab=preview#buy'],
    ['/dashboard', '/dashboard'],
    ['/admin/../newsroom', '/newsroom'],
    ['/%2F%2Fevil.example', '/%2F%2Fevil.example'], // encoded slashes stay a path on our site
  ])('keeps the same-origin path %j', (next, expected) => {
    expect(safeNext(next, ORIGIN)).toBe(expected);
  });

  it('every accepted value resolves to our own origin', () => {
    for (const next of ['/a', '/a/../b', '/%5Cx', '/?q=//evil', '/#//evil']) {
      const out = safeNext(next, ORIGIN);
      expect(out).not.toBeNull();
      expect(new URL(out!, ORIGIN).origin).toBe(ORIGIN);
    }
  });
});

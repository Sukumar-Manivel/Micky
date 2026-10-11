import { describe, expect, it } from 'vitest';
import { apiSources, buildCsp } from './csp';

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

describe('buildCsp', () => {
  const prod = directives(buildCsp({ apiUrl: 'https://api.firstframe.in/' }));

  it('allows the runtime API origin for data, media, images and its websocket', () => {
    expect(prod.get('connect-src')).toEqual(expect.arrayContaining(['https://api.firstframe.in', 'wss://api.firstframe.in']));
    expect(prod.get('media-src')).toEqual(expect.arrayContaining(['https://api.firstframe.in', 'blob:']));
    expect(prod.get('img-src')).toEqual(expect.arrayContaining(['https://api.firstframe.in', 'https://tile.openstreetmap.org']));
  });

  it('allows Razorpay Checkout and nothing else from outside for scripts and frames', () => {
    expect(prod.get('script-src')).toEqual(["'self'", "'unsafe-inline'", 'https://checkout.razorpay.com']);
    expect(prod.get('frame-src')).toEqual(['https://api.razorpay.com', 'https://checkout.razorpay.com']);
  });

  it('lets hls.js use blob: workers and media', () => {
    expect(prod.get('worker-src')).toContain('blob:');
  });

  it('forbids framing, plugins and <base> tricks', () => {
    expect(prod.get('frame-ancestors')).toEqual(["'none'"]);
    expect(prod.get('object-src')).toEqual(["'none'"]);
    expect(prod.get('base-uri')).toEqual(["'self'"]);
    expect(prod.has('upgrade-insecure-requests')).toBe(true);
  });

  it('has no eval and no wildcard sources in production', () => {
    const csp = buildCsp({ apiUrl: 'https://api.firstframe.in' });
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).not.toMatch(/(^|\s)\*(\s|;|$)/);
    expect(csp).not.toMatch(/(^|\s)(https?|wss?):(\s|;|$)/);
  });

  it('works with a local http API: no upgrade-insecure-requests, ws:// for Socket.IO', () => {
    const local = directives(buildCsp({ apiUrl: 'http://localhost:4310' }));
    expect(local.has('upgrade-insecure-requests')).toBe(false);
    expect(local.get('connect-src')).toContain('ws://localhost:4310');
  });

  it('adds eval only for next dev', () => {
    expect(buildCsp({ apiUrl: 'http://localhost:4000', dev: true })).toContain("'unsafe-eval'");
  });

  it('ignores an API URL that is not http(s)', () => {
    expect(apiSources('javascript:alert(1)')).toBeNull();
    expect(buildCsp({ apiUrl: 'not a url' })).not.toContain('not');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiBase, apiUrl, normaliseApiUrl } from './config';

describe('normaliseApiUrl', () => {
  it('drops trailing slashes and whitespace', () => {
    expect(normaliseApiUrl(' https://api.example.com/// ')).toBe('https://api.example.com');
  });
  it('rejects values that are not absolute http(s) URLs', () => {
    expect(normaliseApiUrl('')).toBeNull();
    expect(normaliseApiUrl(undefined)).toBeNull();
    expect(normaliseApiUrl('api.example.com')).toBeNull();
    expect(normaliseApiUrl('javascript:alert(1)')).toBeNull();
  });
});

describe('apiUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('prefers the runtime config set by /runtime-config.js', () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://build-time:4000');
    vi.stubGlobal('window', { __FIRSTFRAME_CONFIG__: { apiUrl: 'https://runtime.example.com/' } });
    expect(apiUrl()).toBe('https://runtime.example.com');
    expect(apiBase()).toBe('https://runtime.example.com/api/v1');
  });

  it('falls back to the build-time variable, then to localhost', () => {
    vi.stubGlobal('window', {});
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://build-time:4000');
    expect(apiUrl()).toBe('http://build-time:4000');
    vi.stubEnv('NEXT_PUBLIC_API_URL', '');
    expect(apiUrl()).toBe('http://localhost:4000');
  });
});

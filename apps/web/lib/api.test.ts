import { describe, expect, it } from 'vitest';
import { ApiError, describeError, errorMessageFromBody, toQuery } from './api';

describe('toQuery', () => {
  it('skips empty values and encodes the rest', () => {
    expect(toQuery({ page: 2, q: 'Anna Salai', risk: undefined, status: null, x: '' })).toBe('?page=2&q=Anna+Salai');
    expect(toQuery({})).toBe('');
  });
});

describe('errorMessageFromBody', () => {
  it('joins NestJS validation messages', () => {
    expect(errorMessageFromBody({ message: ['title is too short', 'category is invalid'] }, 400)).toBe(
      'title is too short. category is invalid',
    );
  });
  it('has friendly fallbacks for rate limits and server errors', () => {
    expect(errorMessageFromBody(null, 429)).toMatch(/Too many attempts/);
    expect(errorMessageFromBody('oops', 502)).toMatch(/server had a problem/);
  });
});

describe('describeError', () => {
  it('uses the API message, and explains network failures', () => {
    expect(describeError(new ApiError(409, 'Already sold'))).toBe('Already sold');
    expect(describeError(new TypeError('Failed to fetch'))).toMatch(/Could not reach Micky/);
  });
});

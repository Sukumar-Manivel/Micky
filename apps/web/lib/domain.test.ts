import { describe, expect, it } from 'vitest';
import { domainMatch } from './domain';

describe('domainMatch', () => {
  it('matches an email on the website domain, ignoring www and case', () => {
    expect(domainMatch('desk@NewsTN.in', 'https://www.newstn.in/about')).toBe('match');
  });
  it('matches subdomains in either direction', () => {
    expect(domainMatch('desk@chennai.newstn.in', 'https://newstn.in')).toBe('match');
    expect(domainMatch('desk@newstn.in', 'https://tamil.newstn.in')).toBe('match');
  });
  it('flags a free-mail address for a newsroom website', () => {
    expect(domainMatch('reporter123@gmail.com', 'https://newstn.in')).toBe('mismatch');
  });
  it('does not treat a lookalike domain as a match', () => {
    expect(domainMatch('desk@fakenewstn.in', 'https://newstn.in')).toBe('mismatch');
  });
  it('is unknown without a usable website', () => {
    expect(domainMatch('desk@newstn.in', null)).toBe('unknown');
    expect(domainMatch('desk@newstn.in', 'not a url')).toBe('unknown');
  });
});

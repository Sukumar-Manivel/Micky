import { hammingDistance, isInformativePhash, isValidPhash, minDistance } from './phash.js';

describe('hammingDistance', () => {
  it('is 0 for identical hashes', () => {
    expect(hammingDistance('a1b2c3d4e5f60718', 'a1b2c3d4e5f60718')).toBe(0);
  });

  it('counts differing bits', () => {
    expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1);
    expect(hammingDistance('0000000000000000', '000000000000000f')).toBe(4);
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('8000000000000000', '0000000000000000')).toBe(1);
  });

  it('ignores letter case', () => {
    expect(hammingDistance('ABCDEF0123456789', 'abcdef0123456789')).toBe(0);
  });

  it('returns null for malformed hashes', () => {
    expect(hammingDistance('xyz', '0000000000000000')).toBeNull();
    expect(hammingDistance('00000000000000000', '0000000000000000')).toBeNull();
    expect(isValidPhash('0x00000000000000')).toBe(false);
  });
});

describe('minDistance', () => {
  it('finds the closest pair across all frames', () => {
    const a = ['ffffffffffffffff', '0000000000000003'];
    const b = ['0f0f0f0f0f0f0f0f', '0000000000000000'];
    expect(minDistance(a, b)).toBe(2);
  });

  it('returns null when there is nothing to compare', () => {
    expect(minDistance([], ['0000000000000000'])).toBeNull();
    expect(minDistance(['bad'], ['0000000000000000'])).toBeNull();
  });
});

describe('isInformativePhash', () => {
  it('accepts an ordinary hash', () => {
    expect(isInformativePhash('a1b2c3d4e5f60718')).toBe(true);
  });

  it('rejects hashes of flat frames (almost all bits equal)', () => {
    expect(isInformativePhash('0000000000000000')).toBe(false); // black frame
    expect(isInformativePhash('8000000000000001')).toBe(false); // 2 bits set
    expect(isInformativePhash('ffffffffffffffff')).toBe(false);
    expect(isInformativePhash('fffffffffffffff0')).toBe(true); // 60 bits set: borderline but kept
  });

  it('rejects malformed hashes', () => {
    expect(isInformativePhash('nope')).toBe(false);
  });
});

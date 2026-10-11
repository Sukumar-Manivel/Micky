// Perceptual hashes (pHash) are 64-bit fingerprints of what an image looks like.
// Unlike a SHA-256 checksum, which changes completely if one byte changes,
// similar-looking images get similar pHashes, even after re-compression,
// resizing or a small crop. The verifier service computes them (one per frame)
// as 16 hex characters; here we only compare them.

/** Two frames whose hashes differ in at most this many bits are treated as the same picture. */
export const DUPLICATE_MAX_DISTANCE = 8;

const HEX64 = /^[0-9a-f]{16}$/i;

export function isValidPhash(hash: string): boolean {
  return HEX64.test(hash);
}

/**
 * A hash with almost all bits 0 (or all 1) comes from a frame with no detail:
 * a black screen, a lens cap, a flat sky. Every black frame in the world has
 * the same pHash, so such hashes would flag unrelated uploads as duplicates.
 * The duplicate search ignores them.
 */
export function isInformativePhash(hash: string): boolean {
  if (!isValidPhash(hash)) return false;
  let ones = 0;
  for (let v = BigInt(`0x${hash}`); v > 0n; v >>= 1n) ones += Number(v & 1n);
  return ones >= 4 && ones <= 60;
}

/**
 * Hamming distance between two 64-bit hashes: the number of bits that differ.
 * Returns null if either hash is not 16 hex characters.
 */
export function hammingDistance(a: string, b: string): number | null {
  if (!isValidPhash(a) || !isValidPhash(b)) return null;
  let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (diff > 0n) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

/**
 * Smallest Hamming distance between any frame of `a` and any frame of `b`
 * (null if no valid pair exists). Comparing every pair catches a clip that was
 * trimmed, where frame 1 of the copy matches frame 5 of the original.
 */
export function minDistance(a: readonly string[], b: readonly string[]): number | null {
  let best: number | null = null;
  for (const x of a) {
    for (const y of b) {
      const d = hammingDistance(x, y);
      if (d !== null && (best === null || d < best)) best = d;
    }
  }
  return best;
}

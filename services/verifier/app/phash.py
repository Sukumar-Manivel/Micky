"""Perceptual hashing (pHash) for near-duplicate detection.

A cryptographic hash (SHA-256) changes completely if a single bit changes, so it
only finds byte-identical copies. A *perceptual* hash summarises what the image
looks like, so a re-encoded, resized or slightly cropped copy gets a hash that
differs in only a few bits. The worker compares hashes by Hamming distance
(<= 8 of 64 bits = likely copy, see docs/RESEARCH.md).

How pHash works (ImageHash's implementation):
1. Shrink to 32x32 greyscale (throws away detail and colour).
2. Take the 2-D discrete cosine transform (DCT), like JPEG does.
3. Keep the top-left 8x8 block: the lowest frequencies = the overall structure.
4. Each bit = "is this coefficient above the median?" -> 64 bits = 16 hex chars.
"""

from __future__ import annotations

from collections.abc import Sequence

import imagehash
from PIL import Image

HASH_SIZE = 8  # 8x8 = 64 bits = 16 hex characters, as the contract requires.


def phash_hex(img: Image.Image) -> str:
    """Return the 64-bit pHash of ``img`` as 16 lower-case hex characters."""
    return str(imagehash.phash(img, hash_size=HASH_SIZE))


def phash_frames(frames: Sequence[Image.Image]) -> list[str]:
    """Hash every frame, preserving order."""
    return [phash_hex(f) for f in frames]


def hamming_distance(a: str, b: str) -> int:
    """Number of differing bits between two hex hashes (used in tests and docs)."""
    return (int(a, 16) ^ int(b, 16)).bit_count()

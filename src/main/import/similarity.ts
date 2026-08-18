import { nativeImage } from 'electron';

/**
 * Perceptual hashing for near-duplicate detection.
 *
 * This catches the case time clustering structurally cannot: the same piece
 * photographed on two different days, or the same file imported twice after
 * being renamed. It is deliberately *not* used as the primary grouping signal --
 * two photos of one tractor from the front and from underneath are wildly
 * different images, and a hash would call them unrelated. That judgement is the
 * vision model's job; this is just a cheap safety net.
 */

const HASH_SIDE = 8;

/**
 * Average hash: downscale to 8x8, convert to grey, and set one bit per pixel
 * for "brighter than the mean". Robust to scale, compression, and mild colour
 * shifts; sensitive to composition, which is exactly what we want here.
 */
export function averageHash(buffer: Buffer): bigint | null {
  try {
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) return null;

    const small = image.resize({ width: HASH_SIDE, height: HASH_SIDE, quality: 'good' });
    const bitmap = small.toBitmap(); // BGRA, 4 bytes per pixel

    const pixelCount = HASH_SIDE * HASH_SIDE;
    if (bitmap.length < pixelCount * 4) return null;

    const greys: number[] = [];
    for (let i = 0; i < pixelCount; i += 1) {
      const offset = i * 4;
      const blue = bitmap[offset];
      const green = bitmap[offset + 1];
      const red = bitmap[offset + 2];
      // Rec. 601 luma -- closer to perceived brightness than a flat average.
      greys.push(0.299 * red + 0.587 * green + 0.114 * blue);
    }

    const mean = greys.reduce((sum, value) => sum + value, 0) / greys.length;

    let hash = 0n;
    for (let i = 0; i < pixelCount; i += 1) {
      hash = (hash << 1n) | (greys[i] >= mean ? 1n : 0n);
    }

    return hash;
  } catch {
    return null;
  }
}

export function hammingDistance(a: bigint, b: bigint): number {
  let diff = a ^ b;
  let count = 0;
  while (diff > 0n) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}

/** Out of 64 bits, this threshold is tight enough to mean "effectively the same shot". */
export const NEAR_DUPLICATE_THRESHOLD = 5;

export function isNearDuplicate(a: bigint | null, b: bigint | null): boolean {
  if (a === null || b === null) return false;
  return hammingDistance(a, b) <= NEAR_DUPLICATE_THRESHOLD;
}

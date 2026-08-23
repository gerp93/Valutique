/**
 * Heuristic check for "this file is probably not the original" -- a resized
 * export from iPhoto/Photos, a messaging app, or similar, rather than the
 * camera original. This matters here specifically because the AI appraisal
 * relies on fine detail (maker's marks, wear, print quality) that a
 * standardized reduced-size export has already thrown away.
 *
 * Two independent signals, either one is enough to flag:
 *  - The long edge lands exactly on one of the fixed sizes photo apps export
 *    to (iPhoto's Small/Medium/Large presets, Photos' share sizes, common
 *    web-export sizes). A real camera or phone sensor almost never produces
 *    a round number like 1024 or 2048 -- 4032x3024 is typical.
 *  - The file is low resolution and carries no EXIF camera Make/Model tag.
 *    Cameras and phones always write this; it disappears when a photo app
 *    re-encodes a copy for export. Low resolution alone isn't used, since
 *    plenty of legitimate originals (scans, screenshots) are small.
 */

const STANDARD_EXPORT_LONG_EDGES = new Set([
  320, 400, 480, 640, 720, 800, 960, 1024, 1200, 1280, 1600, 1920, 2048, 2160,
]);

/** Below this, even a real low-res camera photo is unusual for a piece photographed today. */
const LOW_RES_THRESHOLD = 2048;

export interface ReducedSizeCheck {
  looksReduced: boolean;
  reason: string | null;
}

export function checkReducedSize(width: number, height: number, hasCameraExif: boolean): ReducedSizeCheck {
  const longEdge = Math.max(width, height);
  if (longEdge <= 0) return { looksReduced: false, reason: null };

  if (STANDARD_EXPORT_LONG_EDGES.has(longEdge)) {
    return {
      looksReduced: true,
      reason: `${width}×${height} is a standard export size, not a typical camera resolution.`,
    };
  }

  if (longEdge < LOW_RES_THRESHOLD && !hasCameraExif) {
    return {
      looksReduced: true,
      reason: `${width}×${height} with no camera metadata -- looks like a resized copy rather than the original.`,
    };
  }

  return { looksReduced: false, reason: null };
}

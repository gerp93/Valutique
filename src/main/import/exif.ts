/**
 * Minimal EXIF reader: capture timestamp only.
 *
 * When someone photographs a shelf, the angles of one piece are seconds apart
 * and moving to the next piece takes longer. That gap is the cheapest and most
 * reliable grouping signal available, and it costs nothing -- which is why it
 * is worth 120 lines of binary parsing rather than a dependency that would drag
 * in a full metadata library for one tag.
 *
 * Reads DateTimeOriginal (0x9003), falling back to DateTimeDigitized (0x9004)
 * and then the IFD0 DateTime (0x0132).
 */

const TAG_DATETIME = 0x0132;
const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;

interface Reader {
  buffer: Buffer;
  littleEndian: boolean;
  /** Offset of the TIFF header, which all IFD offsets are relative to. */
  tiffStart: number;
}

function u16(reader: Reader, offset: number): number {
  return reader.littleEndian ? reader.buffer.readUInt16LE(offset) : reader.buffer.readUInt16BE(offset);
}

function u32(reader: Reader, offset: number): number {
  return reader.littleEndian ? reader.buffer.readUInt32LE(offset) : reader.buffer.readUInt32BE(offset);
}

/** Finds the APP1 segment holding the "Exif\0\0" header and returns its TIFF offset. */
function findTiffStart(buffer: Buffer): number | null {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return null; // not a JPEG

  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return null;

    const marker = buffer.readUInt16BE(offset);
    // Standalone markers carry no length field.
    if (marker === 0xffd8 || marker === 0xffd9) {
      offset += 2;
      continue;
    }
    // Start of scan: image data follows, so any EXIF would already have appeared.
    if (marker === 0xffda) return null;

    const length = buffer.readUInt16BE(offset + 2);
    if (length < 2) return null;

    if (marker === 0xffe1 && offset + 10 <= buffer.length) {
      if (buffer.toString('ascii', offset + 4, offset + 8) === 'Exif') {
        return offset + 10;
      }
    }

    offset += 2 + length;
  }

  return null;
}

/** Walks one IFD, returning the ASCII value of `wantedTag`, or a sub-IFD offset. */
function readIfd(reader: Reader, ifdOffset: number, wantedTags: number[]): Map<number, string | number> {
  const found = new Map<number, string | number>();
  const base = reader.tiffStart + ifdOffset;

  if (base + 2 > reader.buffer.length) return found;

  const entryCount = u16(reader, base);
  // A corrupt count would send us reading far past the buffer.
  if (entryCount > 512) return found;

  for (let i = 0; i < entryCount; i += 1) {
    const entry = base + 2 + i * 12;
    if (entry + 12 > reader.buffer.length) break;

    const tag = u16(reader, entry);
    if (!wantedTags.includes(tag)) continue;

    const type = u16(reader, entry + 2);
    const count = u32(reader, entry + 4);

    if (type === 2) {
      // ASCII. Values longer than 4 bytes live at an offset instead of inline.
      const valueOffset = count > 4 ? reader.tiffStart + u32(reader, entry + 8) : entry + 8;
      if (valueOffset + count > reader.buffer.length) continue;
      const text = reader.buffer.toString('ascii', valueOffset, valueOffset + count).replace(/\0.*$/, '').trim();
      found.set(tag, text);
    } else if (type === 4) {
      found.set(tag, u32(reader, entry + 8));
    }
  }

  return found;
}

/** "2026:08:16 14:23:07" -- EXIF's own format, which Date cannot parse directly. */
function parseExifDate(text: string): Date | null {
  const match = text.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const date = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  );

  return Number.isNaN(date.getTime()) ? null : date;
}

/** Capture time from EXIF, or null when the file has none (screenshots, edited exports, PNGs). */
export function readCaptureTime(buffer: Buffer): Date | null {
  try {
    const tiffStart = findTiffStart(buffer);
    if (tiffStart === null || tiffStart + 8 > buffer.length) return null;

    const byteOrder = buffer.toString('ascii', tiffStart, tiffStart + 2);
    if (byteOrder !== 'II' && byteOrder !== 'MM') return null;

    const reader: Reader = { buffer, littleEndian: byteOrder === 'II', tiffStart };

    const ifd0Offset = u32(reader, tiffStart + 4);
    const ifd0 = readIfd(reader, ifd0Offset, [TAG_DATETIME, TAG_EXIF_IFD_POINTER]);

    const exifPointer = ifd0.get(TAG_EXIF_IFD_POINTER);
    if (typeof exifPointer === 'number') {
      const exifIfd = readIfd(reader, exifPointer, [TAG_DATETIME_ORIGINAL, TAG_DATETIME_DIGITIZED]);

      const original = exifIfd.get(TAG_DATETIME_ORIGINAL);
      if (typeof original === 'string') {
        const parsed = parseExifDate(original);
        if (parsed) return parsed;
      }

      const digitized = exifIfd.get(TAG_DATETIME_DIGITIZED);
      if (typeof digitized === 'string') {
        const parsed = parseExifDate(digitized);
        if (parsed) return parsed;
      }
    }

    const fallback = ifd0.get(TAG_DATETIME);
    if (typeof fallback === 'string') return parseExifDate(fallback);

    return null;
  } catch {
    // Malformed metadata is common in the wild. Losing the timestamp only
    // costs us a grouping hint, so never let it fail an import.
    return null;
  }
}

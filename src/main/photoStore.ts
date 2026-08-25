import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { nativeImage, protocol } from 'electron';
import heicConvert from 'heic-convert';
import { getMediaPath } from './library';

/**
 * The media library: photo bytes on disk, content-addressed by SHA-256.
 *
 * Photos live outside the database for two reasons. The database stays small
 * enough to sit in a cloud-synced folder, and identical files added twice
 * collapse onto one copy for free -- re-importing a folder you already imported
 * costs no disk and is detectable as a duplicate.
 *
 * Image work uses Electron's built-in `nativeImage` rather than a native
 * module, so there is nothing to rebuild per platform in CI.
 */

export const PHOTO_PROTOCOL = 'valutique-photo';

const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic', '.heif']);

/**
 * HEIC is what an iPhone and iPhoto hand you, and Chromium cannot decode it --
 * so `nativeImage` returns an empty image and every downstream step silently
 * gets zero-by-zero pixels. These are transcoded to JPEG on the way into the
 * library, which keeps the rest of the app working on formats it can read.
 *
 * The decoder is pure JS + wasm on purpose: a native HEIF binding would have to
 * be rebuilt per platform in CI, which this file exists to avoid.
 */
const TRANSCODED_EXTENSIONS = new Set(['.heic', '.heif']);

async function toReadableImage(bytes: Buffer, ext: string): Promise<{ bytes: Buffer; ext: string }> {
  if (!TRANSCODED_EXTENSIONS.has(ext)) return { bytes, ext };
  try {
    const jpeg = await heicConvert({ buffer: bytes, format: 'JPEG', quality: 0.92 });
    return { bytes: Buffer.from(jpeg), ext: '.jpg' };
  } catch (err) {
    throw new Error(`This HEIC photo could not be read: ${(err as Error).message}`);
  }
}

/**
 * Photos live in `media/` inside the library folder. Derived, never
 * configured -- see library.ts for why the two cannot be separated.
 */
export function getEffectiveMediaPath(): string {
  return getMediaPath();
}

export function isSupportedImage(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export interface IngestedPhoto {
  relativePath: string;
  sha256: string;
  width: number;
  height: number;
  byteSize: number;
  /** True when this exact file was already in the library, so no new bytes were written. */
  alreadyPresent: boolean;
}

/** Reads dimensions without copying anything -- used to preview a drop before committing to it. */
export async function inspect(
  sourcePath: string,
  originalBytes?: Buffer
): Promise<{ width: number; height: number; byteSize: number; sha256: string; decoded: Buffer }> {
  const original = originalBytes ?? fs.readFileSync(sourcePath);
  const { bytes } = await toReadableImage(original, path.extname(sourcePath).toLowerCase());
  const image = nativeImage.createFromBuffer(bytes);
  const size = image.isEmpty() ? { width: 0, height: 0 } : image.getSize();
  return {
    width: size.width,
    height: size.height,
    byteSize: original.length,
    // Hashed on the original file, so re-importing the same HEIC is recognised
    // as a duplicate even though what we stored is a JPEG.
    sha256: crypto.createHash('sha256').update(original).digest('hex'),
    // Display-ready bytes: the caller needs these for thumbnails and perceptual
    // hashing, neither of which can read HEIC.
    decoded: bytes,
  };
}

/** Copies a file into the library under its content hash. Idempotent. */
export async function ingest(sourcePath: string): Promise<IngestedPhoto> {
  const original = fs.readFileSync(sourcePath);
  // Hashed on the original bytes so dedupe keys on the file the user actually
  // has, not on whatever the transcoder happened to produce.
  const sha256 = crypto.createHash('sha256').update(original).digest('hex');
  const sourceExt = path.extname(sourcePath).toLowerCase() || '.jpg';
  const { bytes, ext } = await toReadableImage(original, sourceExt);

  // Two levels of fan-out keeps any single directory to a manageable size even
  // for a very large collection.
  const relativePath = path.posix.join(sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}${ext}`);
  const absolute = absolutePathFor(relativePath);

  const alreadyPresent = fs.existsSync(absolute);
  if (!alreadyPresent) {
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, bytes);
  }

  const image = nativeImage.createFromBuffer(bytes);
  const size = image.isEmpty() ? { width: 0, height: 0 } : image.getSize();

  return { relativePath, sha256, width: size.width, height: size.height, byteSize: bytes.length, alreadyPresent };
}

export function absolutePathFor(relativePath: string): string {
  const root = getEffectiveMediaPath();
  const resolved = path.resolve(root, relativePath);
  // The relative path always comes from our own database, but resolving and
  // checking containment costs nothing and stops a corrupted row from reading
  // arbitrary files.
  if (!resolved.startsWith(path.resolve(root))) {
    throw new Error(`Refusing to read outside the media library: ${relativePath}`);
  }
  return resolved;
}

export function exists(relativePath: string): boolean {
  try {
    return fs.existsSync(absolutePathFor(relativePath));
  } catch {
    return false;
  }
}

export function remove(relativePath: string): void {
  try {
    const absolute = absolutePathFor(relativePath);
    if (fs.existsSync(absolute)) fs.unlinkSync(absolute);
  } catch {
    // A missing file on delete is not worth failing the surrounding operation.
  }
}

export interface EncodedImage {
  base64: string;
  mediaType: string;
  width: number;
  height: number;
  /** Rough token cost of this image on a Claude-family model, for the cost estimator. */
  approxTokens: number;
}

/**
 * Prepares a photo for a model call: downscale to `maxEdge` and re-encode as
 * JPEG.
 *
 * This is the single biggest cost lever in the app. Image tokens scale with
 * pixel count -- roughly (width x height) / 750 on Claude-family models -- so
 * sending a 4000px phone photo instead of a 1024px one costs about fifteen
 * times more for no gain in identifying a die-cast tractor.
 */
export function encodeForAi(relativePath: string, maxEdge: number): EncodedImage {
  const absolute = absolutePathFor(relativePath);
  let image = nativeImage.createFromPath(absolute);

  if (image.isEmpty()) {
    throw new Error(`Could not read image: ${relativePath}`);
  }

  const size = image.getSize();
  const longEdge = Math.max(size.width, size.height);

  if (longEdge > maxEdge) {
    const scale = maxEdge / longEdge;
    image = image.resize({
      width: Math.round(size.width * scale),
      height: Math.round(size.height * scale),
      quality: 'good',
    });
  }

  const finalSize = image.getSize();
  const buffer = image.toJPEG(85);

  return {
    base64: buffer.toString('base64'),
    mediaType: 'image/jpeg',
    width: finalSize.width,
    height: finalSize.height,
    approxTokens: Math.ceil((finalSize.width * finalSize.height) / 750),
  };
}

/**
 * Serves library files to the renderer over a custom protocol. Using this
 * rather than `file://` means the renderer keeps `webSecurity` on and can only
 * ever reach files inside the media library.
 *
 * Must be paired with `registerPhotoProtocolScheme()`, called before app ready.
 */
export function registerPhotoProtocol(): void {
  protocol.handle(PHOTO_PROTOCOL, async (request) => {
    try {
      const url = new URL(request.url);
      // URL shape is valutique-photo://media/<ab>/<cd>/<hash>.jpg
      const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const absolute = absolutePathFor(relativePath);

      if (!fs.existsSync(absolute)) {
        return new Response('Not found', { status: 404 });
      }

      const bytes = await fs.promises.readFile(absolute);
      const ext = path.extname(absolute).toLowerCase();
      const mime =
        ext === '.png' ? 'image/png'
        : ext === '.webp' ? 'image/webp'
        : ext === '.gif' ? 'image/gif'
        : ext === '.bmp' ? 'image/bmp'
        : 'image/jpeg';

      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: { 'content-type': mime, 'cache-control': 'max-age=31536000, immutable' },
      });
    } catch (err) {
      return new Response(String(err), { status: 400 });
    }
  });
}

/** Must run before app ready so the scheme is treated as standard and secure. */
export function registerPhotoProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PHOTO_PROTOCOL,
      privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false },
    },
  ]);
}

/** The URL the renderer uses in an <img src>. Content-addressed, so it is safe to cache forever. */
export function photoUrl(relativePath: string): string {
  return `${PHOTO_PROTOCOL}://media/${relativePath.split('/').map(encodeURIComponent).join('/')}`;
}

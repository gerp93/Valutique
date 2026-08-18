import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { app, nativeImage, protocol } from 'electron';
import { readConfig, patchConfig, writeConfig } from './appConfig';

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

const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

export function getDefaultMediaPath(): string {
  return path.join(app.getPath('userData'), 'media');
}

export function getEffectiveMediaPath(): string {
  const configured = readConfig().mediaPath;
  return configured && configured.trim() !== '' ? configured : getDefaultMediaPath();
}

export function isUsingDefaultMediaLocation(): boolean {
  return !readConfig().mediaPath;
}

/**
 * Relocate the media library. Existing files are copied to the new location
 * first, because unlike the database a half-moved photo library shows up as
 * missing images rather than an error.
 */
export function setMediaPath(newPath: string): void {
  const current = getEffectiveMediaPath();
  fs.mkdirSync(newPath, { recursive: true });
  if (fs.existsSync(current) && path.resolve(current) !== path.resolve(newPath)) {
    copyDirectory(current, newPath);
  }
  patchConfig({ mediaPath: newPath });
}

export function resetToDefaultMediaPath(): void {
  const config = readConfig();
  delete config.mediaPath;
  writeConfig(config);
}

function copyDirectory(from: string, to: string): void {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyDirectory(src, dest);
    } else if (!fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
    }
  }
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
export function inspect(sourcePath: string): { width: number; height: number; byteSize: number; sha256: string } {
  const bytes = fs.readFileSync(sourcePath);
  const image = nativeImage.createFromBuffer(bytes);
  const size = image.isEmpty() ? { width: 0, height: 0 } : image.getSize();
  return {
    width: size.width,
    height: size.height,
    byteSize: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

/** Copies a file into the library under its content hash. Idempotent. */
export function ingest(sourcePath: string): IngestedPhoto {
  const bytes = fs.readFileSync(sourcePath);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const ext = path.extname(sourcePath).toLowerCase() || '.jpg';

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

export function libraryStats(): { fileCount: number; totalBytes: number } {
  const root = getEffectiveMediaPath();
  let fileCount = 0;
  let totalBytes = 0;

  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        fileCount += 1;
        totalBytes += fs.statSync(full).size;
      }
    }
  };

  walk(root);
  return { fileCount, totalBytes };
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

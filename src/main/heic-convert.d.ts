/**
 * heic-convert ships no types. Only the one call shape this app uses is
 * declared, rather than pulling in a fuller third-party definition for a
 * single function.
 */
declare module 'heic-convert' {
  interface ConvertOptions {
    buffer: Buffer | Uint8Array;
    format: 'JPEG' | 'PNG';
    /** JPEG only, 0..1. */
    quality?: number;
  }

  function convert(options: ConvertOptions): Promise<ArrayBuffer>;

  export = convert;
}

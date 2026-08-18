export interface Photo {
  id: string;
  itemId: string;
  /** Path inside the media library, relative to the library root. Content-addressed. */
  relativePath: string;
  originalFilename: string;
  /** SHA-256 of the file bytes. Doubles as the dedupe key. */
  sha256: string;
  width: number;
  height: number;
  byteSize: number;
  isPrimary: boolean;
  sortOrder: number;
  createdAt: string;
}

/** Outcome of adding a batch of files straight to one item, including whatever didn't make it in and why. */
export interface AddPhotosResult {
  added: Photo[];
  failed: { fileName: string; error: string }[];
}

/** A file the user dropped in, before it's been assigned to an item. */
export interface StagedPhoto {
  sourcePath: string;
  originalFilename: string;
  width: number;
  height: number;
  byteSize: number;
  /** Populated when this exact file is already in the library, so the UI can warn about a duplicate. */
  duplicateOfItemId: string | null;
}

/**
 * How a dropped batch maps onto items. "Every photo is its own item" is the
 * common case for bulk shelf-clearing; "all photos are one item" is for
 * shooting several angles of a single piece.
 */
export type PhotoGrouping = 'one_item_per_photo' | 'all_photos_one_item';

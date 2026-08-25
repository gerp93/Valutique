/**
 * Which connector automatic grouping would actually use. Null when none can
 * look at photos, in which case grouping silently falls back to capture time --
 * worth saying out loud, since it changes both the result and the cost.
 */
export interface GroupingConnectorInfo {
  name: string;
  billingMode: string;
  free: boolean;
}

/** A running or finished analysis, tracked in the main process so the dialog need not stay open. */
export interface ImportBatch {
  batchId: string;
  collectionId: string;
  status: 'running' | 'done' | 'failed';
  progress: ImportProgress | null;
  error: string | null;
}

export type ImportProgressEvent = ImportProgress & { batchId: string };

/** Result of scanning a chosen folder, including what was passed over and why. */
export interface FolderScan {
  folder: string;
  paths: string[];
  /** Files found but not readable as images -- the number that makes "nothing happened" explicable. */
  skipped: number;
}

export interface AnalyzedPhoto {
  sourcePath: string;
  originalFilename: string;
  width: number;
  height: number;
  byteSize: number;
  sha256: string;
  /** From EXIF where available, else file modification time. Drives time-gap clustering. */
  capturedAt: string | null;
  /** Set when this exact file is already in the library, so it can be skipped rather than duplicated. */
  duplicateOfItemId: string | null;
  duplicateOfItemName: string | null;
  /** Set when a different file looks like the same shot -- flagged, not skipped. */
  nearDuplicateOfIndex: number | null;
  /** True when the file looks like a standardized reduced-size export rather than the original. */
  looksReducedSize: boolean;
  /** Plain-English explanation of why, when `looksReducedSize` is true. */
  reducedSizeReason: string | null;
  /**
   * Small data-URL preview. These files are not in the media library yet, and
   * the renderer cannot read arbitrary disk paths, so the preview travels with
   * the analysis rather than being loaded by the page.
   */
  thumbnail: string;
}

export interface ProposedGroup {
  /** Indexes into `ImportAnalysis.photos`. */
  photoIndexes: number[];
  /** What the model thinks the object is. Empty when grouping came from timestamps alone. */
  label: string;
  confidence: number;
  source: 'ai' | 'time' | 'single';
}

export interface ImportAnalysis {
  photos: AnalyzedPhoto[];
  groups: ProposedGroup[];
  /** Which layer produced the final grouping, so the UI can say how much to trust it. */
  groupingSource: 'ai' | 'time' | 'none';
  /** Plain-English explanation shown above the review grid. */
  groupingNote: string;
  /** Files that were not images, or could not be read. */
  skippedPaths: string[];
}

export interface ImportPlan {
  collectionId: string;
  /** Groups of indexes into the analysis photo list. One group becomes one item. */
  groups: number[][];
  /** Skip files whose bytes are already in the library. */
  skipDuplicates: boolean;
  /** Queue identify (and appraise, per settings) as soon as the items exist. */
  autoProcess: boolean;
}

export interface ImportResult {
  itemsCreated: number;
  photosAdded: number;
  duplicatesSkipped: number;
  jobsQueued: number;
  itemIds: string[];
}

/**
 * Progress pushed to the renderer while a large batch is being analysed.
 *
 * Every phase here is slow and opaque without it: reading hashes, decodes,
 * thumbnails and EXIF-parses each file; grouping may make an AI call; and
 * committing copies bytes into the library. `total` is 0 for phases that
 * aren't per-file, which the bar reads as indeterminate.
 */
export interface ImportProgress {
  phase: 'reading' | 'grouping' | 'committing' | 'done';
  completed: number;
  total: number;
  message: string;
}

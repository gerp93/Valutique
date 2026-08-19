import * as fs from 'fs';
import * as path from 'path';
import { nativeImage } from 'electron';
import {
  AnalyzedPhoto,
  ImportAnalysis,
  ImportPlan,
  ImportResult,
  ProposedGroup,
} from '../../shared/types/import';
import { CollectionService } from '../database/collectionService';
import { ItemService } from '../database/itemService';
import { PhotoService } from '../database/photoService';
import { SettingsService } from '../database/settingsService';
import { ConnectorService } from '../database/connectorService';
import { JobService } from '../database/jobService';
import { AiTasks } from '../ai/tasks';
import { AiImage } from '../ai/types';
import * as photoStore from '../photoStore';
import { readCaptureTime } from './exif';
import { averageHash, isNearDuplicate } from './similarity';

/**
 * The "dump 50 photos in and walk away" pipeline.
 *
 * The design goal is that the user never pre-sorts anything. Three layers run
 * cheapest-first: capture-time clustering (free), one AI pass over thumbnails
 * of the whole batch (about a cent, and the layer that is actually accurate),
 * and near-duplicate hashing (free). Whatever they conclude is committed
 * immediately as real items -- nothing is left in a staging limbo that a crash
 * could lose -- and any mistake is fixed afterwards with merge or split rather
 * than by sorting files up front.
 */

/** Photos of one object are taken seconds apart; moving to the next piece takes longer. */
const TIME_GAP_MS = 45_000;

/** Beyond this many angles it is almost certainly a new object, whatever the timestamps say. */
const MAX_TIME_GROUP_SIZE = 6;

/** Small enough to be nearly free at 50 photos, large enough to tell two similar tractors apart. */
const THUMBNAIL_EDGE = 320;

/** Preview size for the review grid. Travels over IPC, so keep it modest. */
const REVIEW_THUMBNAIL_EDGE = 240;

/** One request per chunk; chunking keeps a huge drop from blowing the context window. */
const GROUPING_CHUNK_SIZE = 24;

export class ImportService {
  constructor(
    private collections: CollectionService,
    private items: ItemService,
    private photos: PhotoService,
    private settings: SettingsService,
    private connectors: ConnectorService,
    private jobs: JobService,
    private tasks: AiTasks
  ) {}

  /**
   * Reads the dropped files and proposes a grouping. Nothing is written to the
   * library yet, so a user who cancels here leaves no trace.
   */
  async analyze(
    collectionId: string,
    filePaths: string[],
    options: { useAi?: boolean } = {}
  ): Promise<ImportAnalysis> {
    const collection = this.collections.getById(collectionId);
    const itemNoun = collection?.itemNoun ?? 'item';

    const photos: AnalyzedPhoto[] = [];
    const skippedPaths: string[] = [];
    const hashes: (bigint | null)[] = [];

    for (const filePath of filePaths) {
      if (!photoStore.isSupportedImage(filePath)) {
        skippedPaths.push(filePath);
        continue;
      }

      try {
        const buffer = fs.readFileSync(filePath);
        const info = photoStore.inspect(filePath);

        // EXIF first; file mtime is a decent proxy for photos that lost their
        // metadata to an edit or an export.
        const captured = readCaptureTime(buffer) ?? safeMtime(filePath);
        const existingItemId = this.photos.findItemByHash(info.sha256);
        const preview = thumbnailFor(filePath, REVIEW_THUMBNAIL_EDGE);

        photos.push({
          sourcePath: filePath,
          originalFilename: path.basename(filePath),
          width: info.width,
          height: info.height,
          byteSize: info.byteSize,
          sha256: info.sha256,
          capturedAt: captured ? captured.toISOString() : null,
          duplicateOfItemId: existingItemId,
          duplicateOfItemName: existingItemId ? this.items.getById(existingItemId)?.name ?? null : null,
          nearDuplicateOfIndex: null,
          thumbnail: preview ? `data:${preview.mediaType};base64,${preview.base64}` : '',
        });

        hashes.push(averageHash(buffer));
      } catch {
        skippedPaths.push(filePath);
      }
    }

    // Sorting by capture time is what makes the gap heuristic meaningful --
    // file listing order is alphabetical, which is only coincidentally
    // chronological.
    const order = photos
      .map((photo, index) => ({ photo, index }))
      .sort((a, b) => {
        if (a.photo.capturedAt && b.photo.capturedAt) return a.photo.capturedAt.localeCompare(b.photo.capturedAt);
        if (a.photo.capturedAt) return -1;
        if (b.photo.capturedAt) return 1;
        return a.photo.originalFilename.localeCompare(b.photo.originalFilename, undefined, { numeric: true });
      });

    const sorted = order.map((entry) => entry.photo);
    const sortedHashes = order.map((entry) => hashes[entry.index]);

    flagNearDuplicates(sorted, sortedHashes);

    const timeGroups = clusterByTime(sorted);

    let groups = timeGroups;
    let groupingSource: ImportAnalysis['groupingSource'] = sorted.some((p) => p.capturedAt) ? 'time' : 'none';
    let groupingNote =
      groupingSource === 'time'
        ? 'Grouped by capture time. Photos taken within about a minute of each other were treated as the same item.'
        : 'These photos have no capture times, so each one is its own item until you group them.';

    if (options.useAi !== false && sorted.length > 1) {
      const aiGroups = await this.groupWithAi(sorted, timeGroups, itemNoun);
      if (aiGroups) {
        groups = aiGroups;
        groupingSource = 'ai';
        groupingNote =
          'Grouped by looking at the photos. Photos showing the same physical object were put together — check the groups below, or just start; merging or splitting later is one click.';
      }
    }

    return { photos: sorted, groups, groupingSource, groupingNote, skippedPaths };
  }

  /**
   * The accurate layer: one request per chunk over thumbnails, asking which
   * photos show the same object. Returns null when no capable connector is
   * configured or the call fails -- in which case the time-based grouping
   * stands rather than the import breaking.
   */
  private async groupWithAi(
    photos: AnalyzedPhoto[],
    timeGroups: ProposedGroup[],
    itemNoun: string
  ): Promise<ProposedGroup[] | null> {
    const connector = this.connectors.resolveConnector('identify');
    if (!connector || !connector.supportsVision) return null;

    try {
      const results: ProposedGroup[] = [];

      for (let start = 0; start < photos.length; start += GROUPING_CHUNK_SIZE) {
        const chunk = photos.slice(start, start + GROUPING_CHUNK_SIZE);
        const images = chunk.map((photo) => thumbnailFor(photo.sourcePath, THUMBNAIL_EDGE));

        if (images.some((image) => image === null)) return null;

        const hint = describeTimeGroups(timeGroups, start, chunk.length);

        const { groups } = await this.tasks.groupPhotos(
          images as AiImage[],
          itemNoun,
          hint,
          connector
        );

        for (const group of groups) {
          results.push({
            // The model numbers photos from 1 within its chunk; translate back
            // to indexes into the full batch.
            photoIndexes: group.photos.map((n) => start + n - 1).filter((i) => i >= 0 && i < photos.length),
            label: group.label,
            confidence: group.confidence,
            source: 'ai',
          });
        }
      }

      const nonEmpty = results.filter((group) => group.photoIndexes.length > 0);
      return nonEmpty.length > 0 ? nonEmpty : null;
    } catch {
      // Grouping is an optimisation, never a gate. A failure here silently
      // falls back to the timestamp grouping the user can still correct.
      return null;
    }
  }

  /** Writes the files into the library, creates the items, and queues the work. */
  commit(analysis: ImportAnalysis, plan: ImportPlan): ImportResult {
    const settings = this.settings.get();

    let itemsCreated = 0;
    let photosAdded = 0;
    let duplicatesSkipped = 0;
    const itemIds: string[] = [];

    for (const group of plan.groups) {
      const usable = group
        .map((index) => analysis.photos[index])
        .filter((photo): photo is AnalyzedPhoto => Boolean(photo))
        .filter((photo) => {
          if (plan.skipDuplicates && photo.duplicateOfItemId) {
            duplicatesSkipped += 1;
            return false;
          }
          return true;
        });

      if (usable.length === 0) continue;

      const item = this.items.create({ collectionId: plan.collectionId });
      itemsCreated += 1;
      itemIds.push(item.id);

      for (const photo of usable) {
        try {
          const ingested = photoStore.ingest(photo.sourcePath);
          this.photos.addToItem(item.id, ingested, photo.originalFilename);
          photosAdded += 1;
        } catch {
          // One unreadable file shouldn't abandon the rest of the batch.
        }
      }
    }

    let jobsQueued = 0;
    if (plan.autoProcess && settings.autoProcessOnImport) {
      // Auto-process on import always runs the deep tier -- there's no UI at
      // import time to choose, and "drop it and walk away" should mean the
      // full, evidence-backed pipeline unless the user explicitly asks for
      // quick via a manual re-run.
      const connector = this.connectors.resolveConnector('identify', 'deep');
      const queued = this.jobs.enqueueMany('identify', 'deep', itemIds, plan.collectionId, connector?.id ?? null);
      jobsQueued = queued.length;

      for (const id of itemIds) {
        this.items.setAiStatus(id, 'queued');
      }
    }

    return { itemsCreated, photosAdded, duplicatesSkipped, jobsQueued, itemIds };
  }
}

function safeMtime(filePath: string): Date | null {
  try {
    return fs.statSync(filePath).mtime;
  } catch {
    return null;
  }
}

/** Encodes a small thumbnail. Small on purpose: 50 of these must stay cheap to send. */
function thumbnailFor(filePath: string, edge: number): AiImage | null {
  try {
    const image = nativeImage.createFromPath(filePath);
    if (image.isEmpty()) return null;

    const size = image.getSize();
    const longEdge = Math.max(size.width, size.height);
    const scale = longEdge > edge ? edge / longEdge : 1;

    const resized = image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
      quality: 'good',
    });

    const finalSize = resized.getSize();
    return {
      base64: resized.toJPEG(75).toString('base64'),
      mediaType: 'image/jpeg',
      approxTokens: Math.ceil((finalSize.width * finalSize.height) / 750),
    };
  } catch {
    return null;
  }
}

function clusterByTime(photos: AnalyzedPhoto[]): ProposedGroup[] {
  const groups: ProposedGroup[] = [];
  let current: number[] = [];
  let previousTime: number | null = null;

  const flush = () => {
    if (current.length > 0) {
      groups.push({
        photoIndexes: current,
        label: '',
        // Timestamps are a real signal but a weak one on their own, and the
        // number is shown to the user -- so it should not read as certainty.
        confidence: current.length === 1 ? 0.4 : 0.55,
        source: current.length === 1 ? 'single' : 'time',
      });
      current = [];
    }
  };

  photos.forEach((photo, index) => {
    const time = photo.capturedAt ? Date.parse(photo.capturedAt) : null;

    const startsNewGroup =
      time === null ||
      previousTime === null ||
      time - previousTime > TIME_GAP_MS ||
      current.length >= MAX_TIME_GROUP_SIZE;

    if (startsNewGroup) flush();

    current.push(index);
    previousTime = time;
  });

  flush();
  return groups;
}

function flagNearDuplicates(photos: AnalyzedPhoto[], hashes: (bigint | null)[]): void {
  for (let i = 0; i < photos.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (isNearDuplicate(hashes[i], hashes[j])) {
        photos[i].nearDuplicateOfIndex = j;
        break;
      }
    }
  }
}

/** Renders the timestamp grouping as a hint the model can confirm or overrule. */
function describeTimeGroups(groups: ProposedGroup[], chunkStart: number, chunkSize: number): string | null {
  const relevant = groups
    .map((group) =>
      group.photoIndexes
        .filter((index) => index >= chunkStart && index < chunkStart + chunkSize)
        .map((index) => index - chunkStart + 1)
    )
    .filter((numbers) => numbers.length > 0);

  if (relevant.length === 0 || relevant.length === chunkSize) return null;

  return relevant.map((numbers) => `- photos ${numbers.join(', ')}`).join('\n');
}

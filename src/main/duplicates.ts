import { ItemListEntry } from '../shared/types/item';
import { ItemService } from './database/itemService';

/**
 * Post-identification duplicate detection.
 *
 * This is what makes the auto-grouping safe to trust. If the importer split two
 * photos of one tractor into two items, both come back from identification with
 * effectively the same name and the same field values -- so instead of asking
 * the user to sort files correctly up front, we let them be wrong and catch it
 * after the AI has done the work.
 *
 * Comparison runs on demand rather than being stored, so a suggestion can never
 * go stale after a merge or an edit.
 */

export interface DuplicateSuggestion {
  itemIds: string[];
  names: string[];
  /** 0-1. Above the threshold these are almost certainly the same physical object. */
  similarity: number;
  reason: string;
}

const SIMILARITY_THRESHOLD = 0.72;

/** Words that carry no identifying information and would inflate every comparison. */
const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'with', 'of', 'in', 'for', 'die', 'cast', 'diecast', 'toy', 'scale', 'model']);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s/]/g, ' ')
      .split(/\s+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 1 && !STOPWORDS.has(token))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) {
    if (b.has(token)) shared += 1;
  }
  return shared / (a.size + b.size - shared);
}

/** Renders an item's list-visible field values into a comparable string. */
function fieldSignature(item: ItemListEntry): string {
  return item.listFieldValues
    .filter((value) => value.value !== null && value.value !== '')
    .map((value) => (Array.isArray(value.value) ? value.value.join(' ') : String(value.value)))
    .join(' ');
}

export class DuplicateDetector {
  constructor(private items: ItemService) {}

  /**
   * Items that look like the same object as `itemId`. Called right after an
   * identify job completes, so the prompt appears while the user is still
   * looking at the import.
   */
  findFor(itemId: string, collectionId: string): DuplicateSuggestion | null {
    const all = this.items.list({ collectionId });
    const target = all.find((item) => item.id === itemId);
    if (!target || !target.name) return null;

    const targetTokens = tokenize(`${target.name} ${fieldSignature(target)}`);
    if (targetTokens.size === 0) return null;

    const matches = all
      .filter((item) => item.id !== itemId && item.name)
      .map((item) => ({
        item,
        similarity: jaccard(targetTokens, tokenize(`${item.name} ${fieldSignature(item)}`)),
      }))
      .filter((entry) => entry.similarity >= SIMILARITY_THRESHOLD)
      .sort((a, b) => b.similarity - a.similarity);

    if (matches.length === 0) return null;

    const best = matches[0];
    return {
      itemIds: [target.id, best.item.id],
      names: [target.name, best.item.name],
      similarity: best.similarity,
      reason: describeReason(best.similarity),
    };
  }

  /**
   * Every likely-duplicate cluster in a collection, for the review screen after
   * a big import. Groups transitively, so three photos of one object that
   * became three items appear as a single suggestion rather than three pairs.
   */
  findAll(collectionId: string): DuplicateSuggestion[] {
    const all = this.items.list({ collectionId }).filter((item) => item.name);
    const tokens = new Map(all.map((item) => [item.id, tokenize(`${item.name} ${fieldSignature(item)}`)]));

    const clusters: string[][] = [];
    const assigned = new Map<string, number>();

    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const a = all[i];
        const b = all[j];
        const similarity = jaccard(tokens.get(a.id)!, tokens.get(b.id)!);
        if (similarity < SIMILARITY_THRESHOLD) continue;

        const clusterA = assigned.get(a.id);
        const clusterB = assigned.get(b.id);

        if (clusterA === undefined && clusterB === undefined) {
          clusters.push([a.id, b.id]);
          assigned.set(a.id, clusters.length - 1);
          assigned.set(b.id, clusters.length - 1);
        } else if (clusterA !== undefined && clusterB === undefined) {
          clusters[clusterA].push(b.id);
          assigned.set(b.id, clusterA);
        } else if (clusterB !== undefined && clusterA === undefined) {
          clusters[clusterB].push(a.id);
          assigned.set(a.id, clusterB);
        }
      }
    }

    const nameById = new Map(all.map((item) => [item.id, item.name]));

    return clusters
      .filter((cluster) => cluster.length > 1)
      .map((cluster) => ({
        itemIds: cluster,
        names: cluster.map((id) => nameById.get(id) ?? ''),
        similarity: 1,
        reason: `${cluster.length} items were identified as the same thing.`,
      }));
  }
}

function describeReason(similarity: number): string {
  if (similarity > 0.9) return 'These were identified as the same item.';
  if (similarity > 0.8) return 'These look like the same item with slightly different wording.';
  return 'These may be the same item — worth a look.';
}

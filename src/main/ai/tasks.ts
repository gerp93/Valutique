import { AiConnector, AiTier } from '../../shared/types/connector';
import { SuggestedField } from '../../shared/types/fieldDef';
import { CONDITION_GRADES, ConditionGrade } from '../../shared/types/item';
import { AppraisalComp } from '../../shared/types/appraisal';
import { CollectionService } from '../database/collectionService';
import { FieldDefService, slugifyKey } from '../database/fieldDefService';
import { ItemService } from '../database/itemService';
import { PhotoService } from '../database/photoService';
import { AppraisalService } from '../database/appraisalService';
import { SettingsService } from '../database/settingsService';
import * as photoStore from '../photoStore';
import { ProviderRegistry } from './registry';
import { AiCapabilityError, AiError } from './errors';
import { AiImage, AiResponse } from './types';
import { estimateCost } from './cost';
import {
  buildAppraiseSchema,
  buildGroupPhotosSchema,
  buildIdentifySchema,
  buildSuggestFieldsSchema,
} from './schemaBuilder';
import {
  appraiseSystemPrompt,
  appraiseUserPrompt,
  groupPhotosSystemPrompt,
  groupPhotosUserPrompt,
  identifySystemPrompt,
  identifyUserPrompt,
  suggestFieldsSystemPrompt,
  suggestFieldsUserPrompt,
} from './prompts';
import { appearedInSearch, verifyUrls } from './urlVerify';
import { formatListings, searchListings } from './ebay';

/** What a completed task hands back to the job runner for the cost surface. */
export interface TaskOutcome {
  tokensIn: number | null;
  tokensOut: number | null;
  webSearches: number;
  costEstimate: number | null;
  durationMs: number;
  summary: string;
}

interface IdentifyPayload {
  name?: string;
  description?: string;
  condition_grade?: string;
  condition_notes?: string | null;
  identification_confidence?: number;
  uncertain_notes?: string | null;
  fields?: Record<string, unknown>;
}

interface AppraisePayload {
  value_low?: number | null;
  value_mid?: number | null;
  value_high?: number | null;
  currency?: string;
  condition_assessed?: string | null;
  confidence?: number;
  rationale?: string;
  comps?: {
    source?: string;
    title?: string;
    url?: string;
    price?: number | null;
    currency?: string | null;
    sold_date?: string | null;
    condition?: string | null;
    listing_type?: string;
    similarity_note?: string | null;
  }[];
}

export interface PhotoGroupResult {
  photos: number[];
  label: string;
  confidence: number;
}

export class AiTasks {
  constructor(
    private collections: CollectionService,
    private fieldDefs: FieldDefService,
    private items: ItemService,
    private photos: PhotoService,
    private appraisals: AppraisalService,
    private settings: SettingsService,
    private registry: ProviderRegistry
  ) {}

  // --- identify ------------------------------------------------------------

  async identify(
    itemId: string,
    tier: AiTier,
    connector: AiConnector,
    signal?: AbortSignal,
    onCliOutput?: (line: string) => void
  ): Promise<TaskOutcome> {
    const started = Date.now();

    const item = this.items.getById(itemId);
    if (!item) throw new AiError(`Item ${itemId} no longer exists.`, false);

    const collection = this.collections.getById(item.collectionId);
    if (!collection) throw new AiError('Collection no longer exists.', false);

    const defs = this.fieldDefs.getForCollection(item.collectionId);
    const images = this.loadImages(itemId);

    if (images.length === 0) {
      throw new AiCapabilityError('This item has no photos to identify from.');
    }

    const response = await this.registry.for(connector).complete(
      connector,
      {
        system: identifySystemPrompt(collection, defs),
        prompt: identifyUserPrompt(images.length, item.name || null),
        images,
        schema: buildIdentifySchema(defs),
        onCliOutput,
      },
      signal
    );

    const payload = response.json as IdentifyPayload | null;
    if (!payload || typeof payload !== 'object') {
      throw new AiError('The model did not return usable structured data.', true, response.text.slice(0, 500));
    }

    // The owner's own notes are never touched -- only fields the AI owns.
    this.items.update(itemId, {
      name: payload.name?.trim() || item.name,
      description: payload.description?.trim() ?? item.description,
      conditionGrade: normaliseGrade(payload.condition_grade),
      conditionNotes: payload.condition_notes ?? item.conditionNotes,
    });

    this.items.setAiTier(itemId, tier);

    if (payload.fields && typeof payload.fields === 'object') {
      // Per-field confidence isn't requested from the model any more: an
      // open-ended {field_key: number} map needs additionalProperties: true
      // on its schema, which Anthropic's structured-output subset rejects
      // outright. identification_confidence above is the confidence signal
      // that actually reaches the API.
      this.items.setFieldValuesByKey(itemId, payload.fields, { fromAi: true });
    }

    const outcome = this.buildOutcome(
      connector,
      response,
      started,
      payload.name ? `Identified as "${payload.name}"` : 'Identified'
    );

    // Goes through setAiNotes(), never update() -- the owner's own notes field
    // is never touched by this. Overwritten each run rather than appended,
    // since this describes the current run's read, not a running log; a
    // resolved uncertainty from three runs ago shouldn't linger forever.
    this.items.setAiNotes(itemId, payload.uncertain_notes ?? null);

    return outcome;
  }

  // --- appraise ------------------------------------------------------------

  async appraise(
    itemId: string,
    tier: AiTier,
    connector: AiConnector,
    signal?: AbortSignal,
    onCliOutput?: (line: string) => void
  ): Promise<TaskOutcome> {
    const started = Date.now();

    const item = this.items.getById(itemId);
    if (!item) throw new AiError(`Item ${itemId} no longer exists.`, false);

    const collection = this.collections.getById(item.collectionId);
    if (!collection) throw new AiError('Collection no longer exists.', false);

    const settings = this.settings.get();
    const defs = this.fieldDefs.getForCollection(item.collectionId);
    const values = this.items.getFieldValues(itemId, defs);
    const images = this.loadImages(itemId);

    const fieldSummary = values
      .filter((value) => value.value !== null && value.value !== '')
      .map((value) => {
        const def = defs.find((d) => d.id === value.fieldDefId);
        const rendered = Array.isArray(value.value) ? value.value.join(', ') : String(value.value);
        return `- ${def?.label ?? value.fieldKey}: ${rendered}`;
      })
      .join('\n');

    // Quick is the "one fast read" tier -- no search, no eBay lookup, no comp
    // verification, regardless of what the connector/settings would otherwise
    // allow. That's what actually makes it fast and cheap rather than just
    // "the same pipeline on a cheaper model".
    const canSearch = tier === 'deep' && connector.supportsWebSearch && settings.maxSearchesPerAppraisal > 0;
    const ebayContext =
      tier === 'deep' ? await this.loadEbayContext(item.name, fieldSummary, settings.ebayEnabled) : null;

    const response = await this.registry.for(connector).complete(
      connector,
      {
        system: appraiseSystemPrompt(collection, canSearch),
        prompt: appraiseUserPrompt({
          itemName: item.name,
          description: item.description,
          conditionGrade: item.conditionGrade,
          conditionNotes: item.conditionNotes,
          fieldSummary,
          photoCount: images.length,
          currency: settings.defaultCurrency,
          ebayContext,
        }),
        images,
        schema: buildAppraiseSchema(settings.defaultCurrency),
        webSearch: { enabled: canSearch, maxUses: settings.maxSearchesPerAppraisal },
        onCliOutput,
      },
      signal
    );

    const payload = response.json as AppraisePayload | null;
    if (!payload || typeof payload !== 'object') {
      throw new AiError('The model did not return a usable valuation.', true, response.text.slice(0, 500));
    }

    // On quick, any comps the model names anyway are discarded rather than
    // stored unverified -- "no comps" is the promise this tier makes.
    const comps = tier === 'deep' ? await this.buildComps(payload.comps ?? [], response, settings.verifyCompUrls) : [];

    this.appraisals.create({
      itemId,
      tier,
      connectorId: connector.id,
      connectorLabel: connector.name,
      model: response.model,
      valueLow: numberOrNull(payload.value_low),
      valueMid: numberOrNull(payload.value_mid),
      valueHigh: numberOrNull(payload.value_high),
      currency: payload.currency || settings.defaultCurrency,
      conditionAssessed: payload.condition_assessed ?? null,
      confidence: numberOrNull(payload.confidence),
      rationale: payload.rationale ?? null,
      // Recorded on the appraisal itself so a number produced without search
      // still says so a year later, when nobody remembers the connector setup.
      searchUnavailable: !canSearch,
      comps,
    });

    const mid = numberOrNull(payload.value_mid);
    return this.buildOutcome(
      connector,
      response,
      started,
      mid !== null ? `Valued at ${mid} ${payload.currency || settings.defaultCurrency}` : 'Appraised'
    );
  }

  private async loadEbayContext(
    itemName: string,
    fieldSummary: string,
    enabled: boolean
  ): Promise<string | null> {
    if (!enabled || !itemName) return null;

    const credentials = this.settings.getEbayCredentials();
    if (!credentials) return null;

    try {
      const listings = await searchListings(credentials, itemName, 8);
      return listings.length > 0 ? formatListings(listings) : null;
    } catch {
      // eBay is a supplementary signal. If it's misconfigured or down, the
      // valuation should still happen rather than the whole job failing.
      void fieldSummary;
      return null;
    }
  }

  /**
   * Turns the model's cited comps into rows, checking each one. A link that
   * doesn't resolve, or that never appeared in the provider's own search
   * results, is kept but flagged -- the user sees the evidence and its
   * reliability together rather than a number with invisible support.
   */
  private async buildComps(
    raw: NonNullable<AppraisePayload['comps']>,
    response: AiResponse,
    verify: boolean
  ): Promise<Omit<AppraisalComp, 'id' | 'appraisalId' | 'createdAt'>[]> {
    const withUrls = raw.filter((comp) => typeof comp.url === 'string' && comp.url.trim() !== '');
    const verification = verify ? await verifyUrls(withUrls.map((comp) => comp.url!)) : new Map<string, boolean | null>();

    return withUrls.map((comp) => {
      const url = comp.url!;
      const resolves = verification.get(url) ?? null;
      const inSearch = appearedInSearch(url, response.searchUrls);

      // When the provider gave us its own search results, a citation absent
      // from them is treated as unverified even if it happens to load.
      const verified = response.searchUrls.length > 0 ? (resolves === false ? false : inSearch) : resolves;

      return {
        source: comp.source ?? hostOf(url),
        title: comp.title ?? '',
        url,
        price: numberOrNull(comp.price),
        currency: comp.currency ?? null,
        soldDate: comp.sold_date ?? null,
        condition: comp.condition ?? null,
        listingType: normaliseListingType(comp.listing_type),
        similarityNote: comp.similarity_note ?? null,
        urlVerified: verified,
      };
    });
  }

  // --- suggest fields ------------------------------------------------------

  async suggestFields(
    name: string,
    description: string,
    connector: AiConnector,
    signal?: AbortSignal
  ): Promise<{ fields: SuggestedField[]; outcome: TaskOutcome }> {
    const started = Date.now();

    const response = await this.registry.for(connector).complete(
      connector,
      {
        system: suggestFieldsSystemPrompt(),
        prompt: suggestFieldsUserPrompt(name, description),
        images: [],
        schema: buildSuggestFieldsSchema(),
      },
      signal
    );

    const payload = response.json as { fields?: unknown[] } | null;
    const rawFields = Array.isArray(payload?.fields) ? payload!.fields : [];

    const fields: SuggestedField[] = rawFields
      .map((entry) => entry as Record<string, unknown>)
      .filter((entry) => typeof entry.label === 'string')
      .map((entry) => ({
        key: slugifyKey(String(entry.key ?? entry.label)),
        label: String(entry.label),
        dataType: normaliseDataType(entry.data_type),
        options: Array.isArray(entry.options) ? entry.options.map(String) : [],
        aiHint: entry.ai_hint ? String(entry.ai_hint) : null,
        rationale: String(entry.rationale ?? ''),
      }));

    return {
      fields,
      outcome: this.buildOutcome(connector, response, started, `Proposed ${fields.length} fields`),
    };
  }

  // --- photo grouping ------------------------------------------------------

  /**
   * One call over thumbnails of a whole dropped batch, asking which photos show
   * the same physical object. This is what removes the manual sorting step: 50
   * photos cost one cheap request rather than 50 decisions.
   */
  async groupPhotos(
    images: AiImage[],
    itemNoun: string,
    timeHint: string | null,
    connector: AiConnector,
    signal?: AbortSignal
  ): Promise<{ groups: PhotoGroupResult[]; outcome: TaskOutcome }> {
    const started = Date.now();

    const response = await this.registry.for(connector).complete(
      connector,
      {
        system: groupPhotosSystemPrompt(itemNoun),
        prompt: groupPhotosUserPrompt(images.length, timeHint),
        images,
        schema: buildGroupPhotosSchema(),
      },
      signal
    );

    const payload = response.json as { groups?: unknown[] } | null;
    const raw = Array.isArray(payload?.groups) ? payload!.groups : [];

    const groups = normaliseGroups(raw, images.length);

    return {
      groups,
      outcome: this.buildOutcome(connector, response, started, `Grouped into ${groups.length} items`),
    };
  }

  // --- shared --------------------------------------------------------------

  /** Loads an item's photos, downscaled per settings. Cost scales with pixel count, so this is capped deliberately. */
  private loadImages(itemId: string): AiImage[] {
    const settings = this.settings.get();
    return this.photos
      .getForItem(itemId)
      .slice(0, settings.aiMaxPhotosPerItem)
      .filter((photo) => photoStore.exists(photo.relativePath))
      .map((photo) => photoStore.encodeForAi(photo.relativePath, settings.aiImageMaxEdge));
  }

  private buildOutcome(
    connector: AiConnector,
    response: AiResponse,
    started: number,
    summary: string
  ): TaskOutcome {
    const usage = {
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
      webSearches: response.webSearches,
    };

    return {
      ...usage,
      costEstimate: estimateCost(connector, usage),
      durationMs: Date.now() - started,
      summary,
    };
  }
}

// --- normalisation ---------------------------------------------------------
// Models return close-enough values (title case, synonyms, out-of-range photo
// numbers). Coercing here keeps the tolerance in one place instead of spread
// across the services.

function normaliseGrade(value: unknown): ConditionGrade {
  if (typeof value !== 'string') return 'unknown';
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return (CONDITION_GRADES as readonly string[]).includes(key) ? (key as ConditionGrade) : 'unknown';
}

function normaliseListingType(value: unknown): AppraisalComp['listingType'] {
  const text = String(value ?? '').toLowerCase();
  if (text.includes('sold') || text.includes('complete')) return 'sold';
  if (text.includes('active') || text.includes('current') || text.includes('asking')) return 'active';
  return 'unknown';
}

function normaliseDataType(value: unknown): SuggestedField['dataType'] {
  const allowed = ['text', 'longtext', 'number', 'integer', 'boolean', 'date', 'year', 'enum', 'multi_enum', 'url', 'currency'];
  const text = String(value ?? 'text').toLowerCase();
  return (allowed.includes(text) ? text : 'text') as SuggestedField['dataType'];
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

/**
 * Guarantees a partition: every photo lands in exactly one group. A model that
 * drops a photo or lists one twice would otherwise silently lose or duplicate
 * an item, so anything unaccounted for becomes its own group.
 */
function normaliseGroups(raw: unknown[], photoCount: number): PhotoGroupResult[] {
  const seen = new Set<number>();
  const groups: PhotoGroupResult[] = [];

  for (const entry of raw) {
    const group = entry as Record<string, unknown>;
    const numbers = Array.isArray(group.photos) ? group.photos : [];

    const photos = numbers
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= photoCount && !seen.has(n));

    if (photos.length === 0) continue;
    photos.forEach((n) => seen.add(n));

    groups.push({
      photos,
      label: String(group.label ?? ''),
      confidence: Number(group.confidence ?? 0.5),
    });
  }

  for (let n = 1; n <= photoCount; n += 1) {
    if (!seen.has(n)) {
      groups.push({ photos: [n], label: '', confidence: 0 });
    }
  }

  return groups;
}

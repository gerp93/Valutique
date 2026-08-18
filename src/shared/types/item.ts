import { Appraisal } from './appraisal';
import { Photo } from './photo';
import { AiTier } from './connector';

/**
 * Condition ladder shared by every collection type. Deliberately the common
 * collectibles grading vocabulary rather than anything farm-toy specific --
 * packaging state (MIB/NIB/loose) is a per-collection custom field, not a base
 * column, because it means nothing for a coin or a painting.
 */
export const CONDITION_GRADES = [
  'mint',
  'near_mint',
  'excellent',
  'very_good',
  'good',
  'fair',
  'poor',
  'unknown',
] as const;

export type ConditionGrade = (typeof CONDITION_GRADES)[number];

export const CONDITION_LABELS: Record<ConditionGrade, string> = {
  mint: 'Mint',
  near_mint: 'Near Mint',
  excellent: 'Excellent',
  very_good: 'Very Good',
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  unknown: 'Unknown',
};

/** Where the AI pipeline has got to for this item. */
export type ItemAiStatus = 'none' | 'queued' | 'running' | 'done' | 'error';

export interface Item {
  id: string;
  collectionId: string;
  name: string;
  description: string | null;
  /** The owner's own notes. Never written to by anything but the owner. */
  notes: string | null;
  /** What the AI flagged on its last run -- e.g. what it couldn't determine and why. Overwritten each run, never by the owner typing in the notes field. */
  aiNotes: string | null;
  /** Physical location, e.g. "Garage shelf B, bin 3". */
  location: string | null;
  conditionGrade: ConditionGrade;
  conditionNotes: string | null;
  quantity: number;
  acquiredDate: string | null;
  acquiredPrice: number | null;
  aiStatus: ItemAiStatus;
  /** Which tier ('quick' or 'deep') produced the item's current identify result, if any. */
  aiTier: AiTier | null;
  aiLastRunAt: string | null;
  aiError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Item plus everything the detail view needs, assembled by the service layer. */
export interface ItemDetail extends Item {
  photos: Photo[];
  fieldValues: ItemFieldValue[];
  currentAppraisal: Appraisal | null;
  appraisalHistory: Appraisal[];
}

/**
 * Where a search term was actually found on an item, so a match against text
 * that isn't visible on the card -- a word buried in the description -- comes
 * with an explanation instead of looking like the filter did nothing.
 */
export interface SearchMatch {
  field: 'description' | 'notes' | 'aiNotes' | 'location';
  label: string;
  /** The matched text with a little surrounding context, ellipsized at both ends when trimmed. */
  snippet: string;
}

/** Row in the item grid: enough to render a card without loading full detail. */
export interface ItemListEntry extends Item {
  primaryPhotoId: string | null;
  /** Library-relative path of the cover photo, so the grid can build image URLs without a round trip per card. */
  primaryPhotoPath: string | null;
  photoCount: number;
  estimatedValue: number | null;
  currency: string | null;
  /** Only the field values whose definition has showInList set. */
  listFieldValues: ItemFieldValue[];
  /**
   * Set when a search filter is active and the match wasn't in the name --
   * the name is already shown on the card, so a match there needs no
   * explanation. Null when there's no active search, or the name itself matched.
   */
  searchMatch: SearchMatch | null;
}

export interface ItemFieldValue {
  itemId: string;
  fieldDefId: string;
  fieldKey: string;
  /** Normalized display value. Typed columns back this; see itemService for the mapping. */
  value: string | number | boolean | string[] | null;
  /** True when the AI supplied this and the user hasn't edited it since. Drives the "AI filled" badge. */
  fromAi: boolean;
  /** Model's 0-1 self-reported confidence for this field, when it gave one. */
  confidence: number | null;
}

export interface CreateItemInput {
  collectionId: string;
  name?: string;
  description?: string | null;
  notes?: string | null;
  location?: string | null;
  conditionGrade?: ConditionGrade;
  conditionNotes?: string | null;
  quantity?: number;
  acquiredDate?: string | null;
  acquiredPrice?: number | null;
}

export interface UpdateItemInput {
  name?: string;
  description?: string | null;
  notes?: string | null;
  location?: string | null;
  conditionGrade?: ConditionGrade;
  conditionNotes?: string | null;
  quantity?: number;
  acquiredDate?: string | null;
  acquiredPrice?: number | null;
}

export interface ItemFilter {
  collectionId: string;
  search?: string;
  conditionGrade?: ConditionGrade;
  location?: string;
  /** 'appraised' | 'unappraised' | undefined for all. */
  appraisalState?: 'appraised' | 'unappraised';
  aiStatus?: ItemAiStatus;
}

export interface Collection {
  id: string;
  name: string;
  /** What one entry is called in this collection -- "toy", "figure", "coin". Used in UI copy and AI prompts. */
  itemNoun: string;
  /** Free-text description of what's collected. Feeds the AI prompts so the model knows the domain. */
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateCollectionInput {
  name: string;
  itemNoun: string;
  description?: string | null;
}

export interface UpdateCollectionInput {
  name?: string;
  itemNoun?: string;
  description?: string | null;
}

/** Roll-up shown on the collections list -- computed, not stored. */
export interface CollectionSummary extends Collection {
  itemCount: number;
  photoCount: number;
  /** Sum of the current appraisal midpoint across items that have one. */
  estimatedValue: number;
  /** Items with no current appraisal, so the user knows the total is incomplete. */
  unappraisedCount: number;
}

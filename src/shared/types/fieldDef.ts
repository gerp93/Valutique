/**
 * Custom field definitions are what keep the database collection-agnostic: the
 * base item row holds only what every collectible has, and everything
 * domain-specific (Scale and Model Brand for farm toys, Character and Wave for
 * action figures) lives here as data. At AI call time these rows are compiled
 * into a JSON schema, so adding a field changes what the model extracts with no
 * code change.
 */
export type FieldDataType =
  | 'text'
  | 'longtext'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'year'
  | 'enum'
  | 'multi_enum'
  | 'url'
  | 'currency';

export interface FieldDef {
  id: string;
  collectionId: string;
  /** Stable machine key, e.g. "model_brand". Used as the JSON schema property name. */
  key: string;
  /** Human label, e.g. "Model Brand". */
  label: string;
  dataType: FieldDataType;
  /** Allowed values for enum / multi_enum. Empty for other types. */
  options: string[];
  required: boolean;
  sortOrder: number;
  /** Whether the AI should try to fill this from photos. Off for things only the owner knows (purchase price). */
  aiExtractable: boolean;
  /** Extra guidance handed to the model for this field, e.g. "Scale is usually stamped on the base". */
  aiHint: string | null;
  /** Show this field as a column/badge in the item grid. */
  showInList: boolean;
  createdAt: string;
}

export interface CreateFieldDefInput {
  collectionId: string;
  key: string;
  label: string;
  dataType: FieldDataType;
  options?: string[];
  required?: boolean;
  sortOrder?: number;
  aiExtractable?: boolean;
  aiHint?: string | null;
  showInList?: boolean;
}

export interface UpdateFieldDefInput {
  label?: string;
  dataType?: FieldDataType;
  options?: string[];
  required?: boolean;
  sortOrder?: number;
  aiExtractable?: boolean;
  aiHint?: string | null;
  showInList?: boolean;
}

/** A field the AI proposed at collection-creation time, pending the user's accept/edit/reject. */
export interface SuggestedField {
  key: string;
  label: string;
  dataType: FieldDataType;
  options: string[];
  aiHint: string | null;
  /** Why the model thinks this field matters for this collection -- shown next to the accept toggle. */
  rationale: string;
}

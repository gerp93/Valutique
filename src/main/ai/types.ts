import { AiConnector, ConnectorTestResult } from '../../shared/types/connector';

/** A photo, already downscaled and base64-encoded by the photo store. */
export interface AiImage {
  base64: string;
  mediaType: string;
  /** Rough token cost, carried through so the cost estimator doesn't have to re-measure. */
  approxTokens: number;
}

/**
 * JSON Schema subset the schema builder emits and every provider understands.
 *
 * `type` is optional because a nullable field is expressed as
 * `{ anyOf: [<schema with type>, {type: "null"}] }` rather than
 * `type: ["string", "null"]` -- the array form is valid JSON Schema but is
 * rejected by Anthropic's structured-output validator. See schemaBuilder.ts.
 */
export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  anyOf?: JsonSchema[];
  description?: string;
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface AiRequest {
  system: string;
  prompt: string;
  images: AiImage[];
  /**
   * Shape the answer must take. Providers that can enforce it server-side do;
   * the rest get it rendered into the prompt and their reply is parsed
   * defensively.
   */
  schema?: JsonSchema;
  /** Ask the provider to search the live web. Ignored by connectors that can't. */
  webSearch?: { enabled: boolean; maxUses: number };
  maxTokens?: number;
  /**
   * Progress lines as a CLI connector's subprocess produces them -- a tool
   * call, a chunk of reasoning, a raw stderr line. HTTP connectors have
   * nothing to report here and ignore it; it exists so a job that would
   * otherwise be a silent black box for minutes at a time (an agent CLI doing
   * real work) shows what it's actually doing, live, in the job's console.
   */
  onCliOutput?: (line: string) => void;
}

export interface AiResponse {
  /** Parsed structured payload, or null when nothing JSON-shaped came back. */
  json: unknown | null;
  /** Raw text of the reply, kept for error messages and debugging. */
  text: string;
  tokensIn: number | null;
  tokensOut: number | null;
  /** How many provider-side searches ran. Billed separately by some providers. */
  webSearches: number;
  /**
   * URLs the provider's own search surfaced. Appraisal cross-checks the
   * model's cited comps against these -- a link the model produced that never
   * appeared in a search result is a strong hallucination signal.
   */
  searchUrls: string[];
  model: string | null;
}

/**
 * Every connector, HTTP or subprocess, reduces to this one call. It is what
 * lets the job runner stay identical across an API key, a local Ollama server,
 * and a subscription-authenticated CLI.
 */
export interface AiProvider {
  complete(connector: AiConnector, request: AiRequest, signal?: AbortSignal): Promise<AiResponse>;
  /** Cheap round-trip used by the Settings "Test connection" button. */
  test(connector: AiConnector): Promise<ConnectorTestResult>;
}

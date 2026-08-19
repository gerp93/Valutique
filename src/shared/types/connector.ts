/**
 * Providers are transport-shaped, not brand-shaped: `openai_compatible` covers
 * OpenAI, OpenRouter, GitHub Models, and every local server that speaks the
 * same wire format (Ollama, LM Studio, llama.cpp, vLLM, HF TGI), so a local
 * Hugging Face model needs no special-casing anywhere in the app.
 */
export type ConnectorProvider =
  | 'anthropic'
  | 'gemini'
  | 'openai_compatible'
  | 'claude_cli'
  | 'gemini_cli';

export type ConnectorTransport = 'http' | 'cli';

/**
 * How using this connector actually costs the user money. This is surfaced in
 * the UI everywhere a run can be started, because "does this batch cost $9 or
 * nothing" is the question that decides which connector someone picks.
 */
export type BillingMode =
  /** Metered per token against prepaid API credits. Spend is estimated and tracked. */
  | 'api_credits'
  /** Draws on a subscription the user already pays for (Claude Pro/Max, Gemini). No incremental cost, but rate-limited. */
  | 'subscription'
  /** Runs on the user's own hardware. Free and unlimited. */
  | 'local_free';

/** Which AI task a connector can be bound to. */
export type AiTask = 'identify' | 'appraise' | 'suggest_fields';

export const AI_TASKS: AiTask[] = ['identify', 'appraise', 'suggest_fields'];

export const AI_TASK_LABELS: Record<AiTask, string> = {
  identify: 'Identify & describe',
  appraise: 'Appraise',
  suggest_fields: 'Suggest custom fields',
};

export const AI_TASK_DESCRIPTIONS: Record<AiTask, string> = {
  identify: "Reads an item's photos to name it, write a description, grade condition, and fill the collection's custom fields.",
  appraise: 'Values an item from its photos and identity, and finds comparable listings to justify the number.',
  suggest_fields: 'Proposes a starting set of custom fields when you create a collection.',
};

/**
 * How thoroughly identify/appraise should run. `suggest_fields` is a single
 * cheap call either way and isn't tiered -- only `identify` and `appraise`
 * expose a choice.
 */
export type AiTier = 'quick' | 'deep';

export const AI_TIERS: AiTier[] = ['quick', 'deep'];

/** Tasks a user actually picks a tier for. `suggest_fields` always runs as 'deep' internally. */
export const TIERED_TASKS: AiTask[] = ['identify', 'appraise'];

export const AI_TIER_LABELS: Record<AiTier, string> = {
  quick: 'Quick',
  deep: 'Deep',
};

export const AI_TIER_DESCRIPTIONS: Record<AiTier, string> = {
  quick:
    'A single fast read from the model’s own knowledge — no web search, no comp verification. Cheap and quick, but unverified.',
  deep: 'Searches for real comparable listings and verifies every link before saving it. Slower and costs more, but the number is backed by evidence.',
};

/** Per-million-token prices, used only to estimate spend for `api_credits` connectors. */
export interface ConnectorPricing {
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  /** Cost per 1,000 provider-side web searches, where the provider bills them separately. */
  webSearchPerThousand: number | null;
  currency: string;
}

export interface AiConnector {
  id: string;
  name: string;
  provider: ConnectorProvider;
  transport: ConnectorTransport;
  /** HTTP connectors only. For openai_compatible this is the whole point (localhost, OpenRouter, ...). */
  baseUrl: string | null;
  /** Model id. For CLI connectors this is passed through as the CLI's own model flag when set. */
  model: string | null;
  /**
   * CLI connectors only: the executable to run. Usually a bare name like
   * "claude", but an absolute path when the tool lives somewhere this app's
   * PATH doesn't cover. This is a path, never a shell command line -- extra
   * flags belong in `cliArgs`.
   */
  cliCommand: string | null;
  /**
   * Extra arguments prepended to every invocation of a CLI connector, for
   * things like --settings or --add-dir. Stored already tokenised so nothing
   * ever gets re-split by a shell.
   */
  cliArgs: string[];
  /** True when an API key is stored in the OS keychain for this connector. The key itself never leaves the main process. */
  hasApiKey: boolean;
  billingMode: BillingMode;
  supportsVision: boolean;
  /**
   * Whether this connector can search the live web. Appraisal quality depends
   * on it almost entirely -- a connector without it values from model memory,
   * and cannot produce real comp links.
   */
  supportsWebSearch: boolean;
  /** Whether the provider can enforce a JSON schema server-side. When false, we prompt for JSON and parse defensively. */
  supportsStructuredOutput: boolean;
  maxTokens: number;
  /** Anthropic-style effort level, passed through where the provider supports it. */
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  pricing: ConnectorPricing;
  /** Free-form extra request parameters, merged into the provider payload. */
  extraParams: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateConnectorInput {
  name: string;
  provider: ConnectorProvider;
  baseUrl?: string | null;
  model?: string | null;
  cliCommand?: string | null;
  cliArgs?: string[];
  apiKey?: string | null;
  billingMode?: BillingMode;
  supportsVision?: boolean;
  supportsWebSearch?: boolean;
  supportsStructuredOutput?: boolean;
  maxTokens?: number;
  effort?: AiConnector['effort'];
  pricing?: Partial<ConnectorPricing>;
  extraParams?: Record<string, unknown>;
  enabled?: boolean;
}

export interface UpdateConnectorInput extends Partial<Omit<CreateConnectorInput, 'provider'>> {
  /** Pass null to clear the stored key, undefined to leave it untouched. */
  apiKey?: string | null;
}

/**
 * Which connector runs which (task, tier) pair. One row per task/tier
 * combination; a combination with no binding is unavailable. `suggest_fields`
 * only ever has a `deep` row since it isn't tiered.
 */
export interface AiTaskBinding {
  task: AiTask;
  tier: AiTier;
  connectorId: string | null;
  /** Replaces the built-in prompt for this task entirely, when set. */
  promptOverride: string | null;
}

/** Result of the Settings "Test connection" button. */
export interface ConnectorTestResult {
  ok: boolean;
  message: string;
  /** Round-trip latency in ms for a trivial request, so CLI vs API speed is visible before committing to a batch. */
  latencyMs: number | null;
  /** What the connector reported about itself, e.g. resolved model name or CLI version. */
  detail: string | null;
}

/**
 * Defaults per provider. These prefill the "add connector" form so the common
 * cases are one click, and the pricing figures give the cost estimator
 * something real to work with before the user has run anything.
 */
export interface ProviderTemplate {
  provider: ConnectorProvider;
  label: string;
  /** One-line description shown in the provider picker. */
  blurb: string;
  transport: ConnectorTransport;
  billingMode: BillingMode;
  /** Plain-English explanation of what using this actually costs, shown under the billing badge. */
  billingExplainer: string;
  defaultModel: string | null;
  defaultBaseUrl: string | null;
  defaultCliCommand: string | null;
  requiresApiKey: boolean;
  supportsVision: boolean;
  supportsWebSearch: boolean;
  supportsStructuredOutput: boolean;
  defaultPricing: ConnectorPricing;
  /** Caveats worth reading before choosing this, e.g. Claude Pro usage windows. */
  notes: string[];
  /** npm package the app can install for the user when a CLI connector is missing. */
  npmPackage: string | null;
  /** What the user still has to do themselves after installing -- signing in. */
  postInstallHint: string | null;
  /**
   * Whether billing mode is a real choice for this provider. It is only true
   * for `openai_compatible`, which spans a free local server and a metered
   * hosted endpoint. Everywhere else it is a fact about the provider and
   * offering a control would just let the user make their cost estimates wrong.
   */
  billingModeEditable: boolean;
  /** Whether vision support depends on which model the user points this at. */
  visionEditable: boolean;
}

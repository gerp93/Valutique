import { ProviderTemplate } from './types/connector';

/**
 * Defaults for each connector type, plus the plain-English billing copy the UI
 * shows wherever a connector can be chosen.
 *
 * Prices are per million tokens and are *editable per connector* -- they exist
 * so the cost estimator has something real to work with out of the box, not as
 * a source of truth. Providers change pricing; Settings says so and lets the
 * user correct any figure.
 */
export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    provider: 'claude_cli',
    label: 'Claude Code (CLI)',
    blurb: 'Runs the claude CLI you are already signed in to. No API key, no per-token cost.',
    transport: 'cli',
    billingMode: 'subscription',
    billingExplainer:
      'Uses your Claude Pro or Max subscription allowance instead of API credits, so a batch costs nothing beyond what you already pay monthly. In exchange it is slower per item and your plan enforces usage windows -- when one is hit, Valutique pauses the queue and resumes automatically rather than failing the run.',
    defaultModel: null,
    defaultBaseUrl: null,
    defaultCliCommand: 'claude',
    requiresApiKey: false,
    supportsVision: true,
    supportsWebSearch: true,
    supportsStructuredOutput: false,
    defaultPricing: { inputPerMTok: null, outputPerMTok: null, webSearchPerThousand: null, currency: 'USD' },
    notes: [
      'Requires Claude Code installed and logged in (run `claude` once in a terminal to confirm).',
      'Claude Pro has tighter usage windows than Max -- a 300-item batch will likely span more than one window.',
      'Brings its own web search, so appraisals get real comp links at no extra charge.',
    ],
    npmPackage: '@anthropic-ai/claude-code',
    postInstallHint: 'Run `claude` once in a terminal and sign in with your Claude account.',
    billingModeEditable: false,
    visionEditable: false,
  },
  {
    provider: 'gemini_cli',
    label: 'Gemini CLI',
    blurb: 'Runs the gemini CLI signed in with your Google account. Generous free daily allowance.',
    transport: 'cli',
    billingMode: 'subscription',
    billingExplainer:
      "Uses the Gemini CLI's daily request allowance on your Google account rather than metered API billing. A paid Google AI tier raises that ceiling. Like the Claude CLI it is slower per item than a direct API call, and the queue pauses and resumes when you hit the daily cap.",
    defaultModel: null,
    defaultBaseUrl: null,
    defaultCliCommand: 'gemini',
    requiresApiKey: false,
    supportsVision: true,
    supportsWebSearch: true,
    supportsStructuredOutput: false,
    defaultPricing: { inputPerMTok: null, outputPerMTok: null, webSearchPerThousand: null, currency: 'USD' },
    notes: [
      'Requires the Gemini CLI installed and authenticated with a Google account.',
      'Search grounding is included, so appraisals can cite live listings.',
    ],
    npmPackage: '@google/gemini-cli',
    postInstallHint: 'Run `gemini` once in a terminal and sign in with your Google account.',
    billingModeEditable: false,
    visionEditable: false,
  },
  {
    provider: 'anthropic',
    label: 'Anthropic API',
    blurb: 'Direct Claude API access with an API key. Fastest option, billed per token.',
    transport: 'http',
    billingMode: 'api_credits',
    billingExplainer:
      'Billed per token against your Anthropic API credits, separate from any Claude subscription you have. Fast and fully parallel -- a batch that takes a CLI connector all night finishes here in minutes. Valutique estimates spend before each run and tracks the real figure after.',
    defaultModel: 'claude-opus-5',
    defaultBaseUrl: 'https://api.anthropic.com',
    defaultCliCommand: null,
    requiresApiKey: true,
    supportsVision: true,
    supportsWebSearch: true,
    supportsStructuredOutput: true,
    defaultPricing: { inputPerMTok: 5, outputPerMTok: 25, webSearchPerThousand: 10, currency: 'USD' },
    notes: [
      'Defaults to Claude Opus 5 ($5 / $25 per million tokens). Claude Sonnet 5 ($3 / $15) and Haiku 4.5 ($1 / $5) cost less per item -- change the model and the prices below together.',
      'Web search is billed separately at $10 per 1,000 searches and is a large share of appraisal cost.',
      'An API key here is unrelated to a Claude Pro/Max subscription; the subscription only works through the Claude Code connector.',
    ],
    npmPackage: null,
    postInstallHint: null,
    billingModeEditable: false,
    visionEditable: false,
  },
  {
    provider: 'gemini',
    label: 'Google Gemini API',
    blurb: 'Direct Gemini API access with an API key. Cheap per token, search grounding available.',
    transport: 'http',
    billingMode: 'api_credits',
    billingExplainer:
      'Billed per token against your Google AI Studio / Vertex billing account. Typically the cheapest metered option per item, though search grounding is billed per grounded request and can dominate appraisal cost.',
    defaultModel: 'gemini-3.7-flash',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    defaultCliCommand: null,
    requiresApiKey: true,
    supportsVision: true,
    supportsWebSearch: true,
    supportsStructuredOutput: true,
    defaultPricing: { inputPerMTok: 0.75, outputPerMTok: 3.75, webSearchPerThousand: 35, currency: 'USD' },
    notes: [
      'The prices prefilled here are approximate -- check current Google pricing and correct them so the estimator stays honest.',
      'Search grounding and strict JSON schema output cannot always be combined; Valutique falls back to prompt-guided JSON when searching.',
    ],
    npmPackage: null,
    postInstallHint: null,
    billingModeEditable: false,
    visionEditable: false,
  },
  {
    provider: 'openai_compatible',
    label: 'OpenAI-compatible endpoint',
    blurb: 'Any server speaking the OpenAI chat API — including local models. Defaults to Ollama.',
    transport: 'http',
    billingMode: 'local_free',
    billingExplainer:
      'Cost depends entirely on where you point it. A local server (Ollama, LM Studio, llama.cpp, vLLM, Hugging Face TGI) runs on your own hardware and is free and unlimited. A hosted endpoint (OpenAI, OpenRouter, GitHub Models) bills per token -- switch this connector to "API credits" and fill in the prices if you do that.',
    defaultModel: 'qwen2.5vl',
    defaultBaseUrl: 'http://localhost:11434/v1',
    defaultCliCommand: null,
    requiresApiKey: false,
    supportsVision: true,
    supportsWebSearch: false,
    supportsStructuredOutput: true,
    defaultPricing: { inputPerMTok: null, outputPerMTok: null, webSearchPerThousand: null, currency: 'USD' },
    notes: [
      'This is how you run a local Hugging Face model: serve it behind any OpenAI-shaped endpoint and point this connector at the URL.',
      'Pick a vision-capable model — a text-only model cannot read your photos.',
      'No web search. Good for identification and description; appraisals will be guesses from model memory with no real comp links, and Valutique will warn you if you bind it to the appraise task.',
    ],
    npmPackage: null,
    postInstallHint: null,
    // The only provider where billing genuinely varies: a local server is
    // free, a hosted endpoint behind the same wire format is metered.
    billingModeEditable: true,
    // Likewise vision -- it depends entirely on which model is served.
    visionEditable: true,
  },
];

export function templateFor(provider: string): ProviderTemplate | undefined {
  return PROVIDER_TEMPLATES.find((t) => t.provider === provider);
}

export const BILLING_MODE_LABELS: Record<string, string> = {
  api_credits: 'API credits',
  subscription: 'Subscription',
  local_free: 'Free / local',
};

/** Short badge copy shown next to a connector name throughout the app. */
export const BILLING_MODE_BADGES: Record<string, string> = {
  api_credits: 'Billed per token',
  subscription: 'Uses your subscription',
  local_free: 'Free',
};

import { ConnectorProvider } from './types/connector';

/**
 * Known models per provider.
 *
 * Free-text model entry is a trap: a typo produces a 404 at job time rather
 * than at setup time, and -- worse -- switching model without switching prices
 * silently makes every cost estimate wrong. So the price sheet travels with the
 * model here, and the form applies both together.
 *
 * Three shapes of "known" exist, and each provider gets the right one:
 *   - Anthropic: a fixed list, priced.
 *   - Gemini: a fixed list, priced approximately.
 *   - OpenAI-compatible: not knowable ahead of time, but *discoverable* -- the
 *     endpoint's own /v1/models is queried instead (see listRemoteModels).
 *   - CLI connectors: the tool owns its default; blank is the right answer.
 */
export interface KnownModel {
  id: string;
  label: string;
  /** One line on when to pick this one. */
  note: string;
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  webSearchPerThousand: number | null;
  supportsVision: boolean;
}

export const MODEL_CATALOG: Partial<Record<ConnectorProvider, KnownModel[]>> = {
  anthropic: [
    {
      id: 'claude-opus-5',
      label: 'Claude Opus 5',
      note: 'Most capable. Best identification on worn or obscure pieces.',
      inputPerMTok: 5,
      outputPerMTok: 25,
      webSearchPerThousand: 10,
      supportsVision: true,
    },
    {
      id: 'claude-sonnet-5',
      label: 'Claude Sonnet 5',
      note: 'Near-Opus quality at around half the cost. A good default for large collections.',
      inputPerMTok: 3,
      outputPerMTok: 15,
      webSearchPerThousand: 10,
      supportsVision: true,
    },
    {
      id: 'claude-opus-4-8',
      label: 'Claude Opus 4.8',
      note: 'Previous Opus generation. Same price as Opus 5.',
      inputPerMTok: 5,
      outputPerMTok: 25,
      webSearchPerThousand: 10,
      supportsVision: true,
    },
    {
      id: 'claude-sonnet-4-6',
      label: 'Claude Sonnet 4.6',
      note: 'Previous Sonnet generation.',
      inputPerMTok: 3,
      outputPerMTok: 15,
      webSearchPerThousand: 10,
      supportsVision: true,
    },
    {
      id: 'claude-haiku-4-5',
      label: 'Claude Haiku 4.5',
      note: 'Cheapest and fastest. Fine for identification, weaker on unusual pieces.',
      inputPerMTok: 1,
      outputPerMTok: 5,
      webSearchPerThousand: 10,
      supportsVision: true,
    },
  ],
  gemini: [
    {
      id: 'gemini-3.7-flash',
      label: 'Gemini 3.7 Flash',
      note: 'Cheap and quick, the current default tier. Prices below are approximate — check current Google pricing.',
      inputPerMTok: 0.75,
      outputPerMTok: 3.75,
      webSearchPerThousand: 35,
      supportsVision: true,
    },
    {
      id: 'gemini-3.6-flash',
      label: 'Gemini 3.6 Flash',
      note: 'Previous Flash generation, same price as 3.7 through the end of 2026.',
      inputPerMTok: 0.75,
      outputPerMTok: 3.75,
      webSearchPerThousand: 35,
      supportsVision: true,
    },
    {
      id: 'gemini-2.5-pro',
      label: 'Gemini 2.5 Pro',
      note: 'Stronger reasoning, higher cost. Prices below are approximate.',
      inputPerMTok: 1.25,
      outputPerMTok: 10,
      webSearchPerThousand: 35,
      supportsVision: true,
    },
  ],
};

export function modelsFor(provider: ConnectorProvider): KnownModel[] {
  return MODEL_CATALOG[provider] ?? [];
}

export function findModel(provider: ConnectorProvider, id: string): KnownModel | undefined {
  return modelsFor(provider).find((model) => model.id === id);
}

/** Sentinel for the "type it yourself" option, so a new model isn't blocked by our list being stale. */
export const CUSTOM_MODEL = '__custom__';

/**
 * Arguments Valutique must own on a CLI connector. A user-supplied flag that
 * collides with one of these doesn't misbehave visibly -- it quietly changes
 * the output format or the prompt, and the parse fails downstream with a
 * message that points nowhere near the cause.
 */
export const RESERVED_CLI_FLAGS = [
  '-p',
  '--print',
  '--prompt',
  '--output-format',
  '--input-format',
  '--allowedtools',
  '--allowed-tools',
  '-m',
  '--model',
];

export function validateCliArgs(args: string[]): string | null {
  const offender = args.find((arg) => RESERVED_CLI_FLAGS.includes(arg.toLowerCase().split('=')[0]));
  if (offender) {
    return `Valutique sets ${offender} itself — passing it here would break how results are read back. Use the Model field for model selection.`;
  }
  return null;
}

/** Splits a command-line string into argv, respecting quotes. No shell involved. */
export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (const char of input) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  if (current) tokens.push(current);
  return tokens;
}

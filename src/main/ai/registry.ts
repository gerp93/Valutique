import { AiConnector } from '../../shared/types/connector';
import { AiProvider } from './types';
import { AiError } from './errors';
import { AnthropicProvider } from './providers/anthropicProvider';
import { GeminiProvider } from './providers/geminiProvider';
import { OpenAiCompatibleProvider } from './providers/openAiCompatibleProvider';
import { ClaudeCliProvider } from './providers/claudeCliProvider';
import { GeminiCliProvider } from './providers/geminiCliProvider';

/**
 * Resolves a connector row to the implementation that can run it.
 *
 * Everything above this line -- the job runner, the AI tasks, the cost
 * estimator -- deals only in `AiProvider`, which is why an API key, a local
 * Ollama server, and a subscription-authenticated CLI are interchangeable
 * without a single conditional outside this file.
 */
export class ProviderRegistry {
  private providers: Record<string, AiProvider>;

  constructor(getApiKey: (connectorId: string) => string | null) {
    this.providers = {
      anthropic: new AnthropicProvider(getApiKey),
      gemini: new GeminiProvider(getApiKey),
      openai_compatible: new OpenAiCompatibleProvider(getApiKey),
      claude_cli: new ClaudeCliProvider(),
      gemini_cli: new GeminiCliProvider(),
    };
  }

  for(connector: AiConnector): AiProvider {
    const provider = this.providers[connector.provider];
    if (!provider) {
      throw new AiError(`No implementation for provider "${connector.provider}".`, false);
    }
    return provider;
  }
}

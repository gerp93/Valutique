import Anthropic from '@anthropic-ai/sdk';
import { AiConnector, ConnectorTestResult } from '../../../shared/types/connector';
import { AiAuthError, AiCapabilityError, AiError, AiRateLimitError, resumeTimeFrom } from '../errors';
import { extractJson, schemaInstruction } from '../jsonExtract';
import { AiProvider, AiRequest, AiResponse } from '../types';

/** How many times a paused turn may be resumed before we call it runaway. */
const MAX_CONTINUATIONS = 5;

/** Models where the server-side refusal fallback is available and worth enabling. */
const FALLBACK_CAPABLE = /^claude-(opus-5|fable-5|mythos-5)/;

type AnyBlock = { type: string; [key: string]: unknown };

export class AnthropicProvider implements AiProvider {
  constructor(private getApiKey: (connectorId: string) => string | null) {}

  private client(connector: AiConnector): Anthropic {
    const apiKey = this.getApiKey(connector.id);
    if (!apiKey) {
      throw new AiAuthError(`No API key stored for "${connector.name}". Add one in Settings.`);
    }
    return new Anthropic({
      apiKey,
      baseURL: connector.baseUrl || undefined,
      maxRetries: 2,
    });
  }

  async complete(connector: AiConnector, request: AiRequest, signal?: AbortSignal): Promise<AiResponse> {
    const client = this.client(connector);
    const model = connector.model || 'claude-opus-5';
    const wantsSearch = Boolean(request.webSearch?.enabled) && connector.supportsWebSearch;

    if (request.images.length > 0 && !connector.supportsVision) {
      throw new AiCapabilityError(`"${connector.name}" is not configured for image input.`);
    }

    // Structured output is only used when we are *not* searching. Strict
    // server-side schemas and search grounding don't reliably coexist, and a
    // rejected request is worse than parsing JSON out of a text reply -- which
    // the extractor handles well.
    const useStructuredOutput = connector.supportsStructuredOutput && Boolean(request.schema) && !wantsSearch;

    const systemText =
      request.schema && !useStructuredOutput
        ? `${request.system}\n\n${schemaInstruction(request.schema)}`
        : request.system;

    const content: Anthropic.ContentBlockParam[] = [
      ...request.images.map(
        (image): Anthropic.ContentBlockParam => ({
          type: 'image',
          source: { type: 'base64', media_type: image.mediaType as 'image/jpeg', data: image.base64 },
        })
      ),
      { type: 'text', text: request.prompt },
    ];

    const messages: Anthropic.MessageParam[] = [{ role: 'user', content }];

    const tools = wantsSearch
      ? [
          {
            type: 'web_search_20260209' as const,
            name: 'web_search' as const,
            max_uses: request.webSearch?.maxUses ?? 3,
          },
        ]
      : undefined;

    const params: Record<string, unknown> = {
      model,
      max_tokens: request.maxTokens ?? connector.maxTokens ?? 16000,
      system: systemText,
      messages,
      ...(tools ? { tools } : {}),
      ...(connector.effort ? { output_config: { effort: connector.effort } } : {}),
      ...(useStructuredOutput
        ? { output_config: { ...(connector.effort ? { effort: connector.effort } : {}), format: { type: 'json_schema', schema: request.schema } } }
        : {}),
      ...connector.extraParams,
    };

    // Safety classifiers can decline a request outright. On the models that
    // support it, let the API re-serve the request on a fallback model rather
    // than handing back an empty response.
    const useFallbacks = FALLBACK_CAPABLE.test(model);

    let response = await this.send(client, params, useFallbacks, signal);

    let tokensIn = response.usage?.input_tokens ?? 0;
    let tokensOut = response.usage?.output_tokens ?? 0;
    let searches = countSearches(response);
    let searchUrls = collectSearchUrls(response);

    // A server-side tool loop that hits its own iteration cap comes back
    // `pause_turn`. Resuming is just re-sending with the paused turn appended --
    // this is the only loop in the app, and it is bounded.
    let continuations = 0;
    while (response.stop_reason === 'pause_turn' && continuations < MAX_CONTINUATIONS) {
      continuations += 1;
      messages.push({ role: 'assistant', content: response.content as Anthropic.ContentBlockParam[] });
      response = await this.send(client, { ...params, messages }, useFallbacks, signal);

      tokensIn += response.usage?.input_tokens ?? 0;
      tokensOut += response.usage?.output_tokens ?? 0;
      searches += countSearches(response);
      searchUrls = searchUrls.concat(collectSearchUrls(response));
    }

    if (response.stop_reason === 'refusal') {
      const category =
        (response as unknown as { stop_details?: { category?: string } }).stop_details?.category ?? 'unspecified';
      throw new AiError(`Claude declined this request (${category}).`, false);
    }

    const text = (response.content as unknown as AnyBlock[])
      .filter((block) => block.type === 'text')
      .map((block) => String(block.text ?? ''))
      .join('\n')
      .trim();

    if (response.stop_reason === 'max_tokens' && !text) {
      throw new AiError('Response hit the token limit before producing any output. Raise Max tokens for this connector.', true);
    }

    return {
      json: request.schema ? extractJson(text) : null,
      text,
      tokensIn,
      tokensOut,
      webSearches: searches,
      searchUrls: Array.from(new Set(searchUrls)),
      model: response.model ?? model,
    };
  }

  private async send(
    client: Anthropic,
    params: Record<string, unknown>,
    useFallbacks: boolean,
    signal?: AbortSignal
  ): Promise<Anthropic.Message> {
    try {
      if (useFallbacks) {
        return (await client.beta.messages.create(
          { ...params, fallbacks: 'default', betas: ['server-side-fallback-2026-07-01'] } as never,
          { signal }
        )) as unknown as Anthropic.Message;
      }
      return (await client.messages.create(params as never, { signal })) as Anthropic.Message;
    } catch (err) {
      throw translateError(err);
    }
  }

  async test(connector: AiConnector): Promise<ConnectorTestResult> {
    const started = Date.now();
    try {
      const client = this.client(connector);
      const model = connector.model || 'claude-opus-5';
      const response = (await client.messages.create({
        model,
        max_tokens: 16,
        messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      } as never)) as Anthropic.Message;

      return {
        ok: true,
        message: 'Connected.',
        latencyMs: Date.now() - started,
        detail: `Model ${response.model ?? model} responded.`,
      };
    } catch (err) {
      const translated = translateError(err);
      return { ok: false, message: translated.message, latencyMs: Date.now() - started, detail: translated.detail ?? null };
    }
  }
}

function countSearches(response: Anthropic.Message): number {
  const usage = response.usage as unknown as { server_tool_use?: { web_search_requests?: number } };
  if (typeof usage?.server_tool_use?.web_search_requests === 'number') {
    return usage.server_tool_use.web_search_requests;
  }

  // Fall back to counting *results*, not every server_tool_use block. The
  // web_search_20260209 tool runs dynamic filtering via code execution under
  // the hood, and that filtering step emits its own server_tool_use block with
  // a different tool name -- counting all such blocks (as this used to)
  // treated each filtering pass as an extra billed search and overstated
  // Valutique's own estimate above what Anthropic actually charged for the
  // same run. A web_search_tool_result block is emitted exactly once per
  // completed search, which is the number $10-per-1,000 is actually billed on.
  return (response.content as unknown as AnyBlock[]).filter((b) => b.type === 'web_search_tool_result').length;
}

/**
 * URLs the provider's own search actually returned. Appraisal compares the
 * model's cited comps against this set: a link that never appeared in a real
 * search result is almost certainly invented.
 */
function collectSearchUrls(response: Anthropic.Message): string[] {
  const urls: string[] = [];
  for (const block of response.content as unknown as AnyBlock[]) {
    if (block.type !== 'web_search_tool_result') continue;
    const results = block.content;
    if (!Array.isArray(results)) continue;
    for (const result of results as AnyBlock[]) {
      if (typeof result.url === 'string') urls.push(result.url);
    }
  }
  return urls;
}

function translateError(err: unknown): AiError {
  if (err instanceof AiError) return err;

  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    const retryAfter = (err.headers as Record<string, string> | undefined)?.['retry-after'];

    if (status === 429 || status === 529) {
      return new AiRateLimitError(
        'Anthropic is rate limiting or overloaded. The queue will resume automatically.',
        resumeTimeFrom(retryAfter, 5 * 60 * 1000),
        err.message
      );
    }
    if (status === 401 || status === 403) {
      return new AiAuthError('Anthropic rejected the API key.', err.message);
    }
    if (status >= 500) {
      return new AiError('Anthropic returned a server error.', true, err.message);
    }
    return new AiError(err.message, false);
  }

  const message = err instanceof Error ? err.message : String(err);
  return new AiError(message, true);
}
